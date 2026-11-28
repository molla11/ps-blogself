import { configManager } from '../config';
import { PendingMemos } from '../writing/PendingMemos';
import { MemoPreparationQueue, MEMO_COOLDOWN, looksLikeNewSolution, meritsAutomaticMemo } from '../writing/MemoPreparation';
import type { FileHistory } from '../types';
import { fileWatcher } from '../storage/FileWatcher';
import { Logger } from './logger';
import { backendRequests } from '../writing/BackendRequests';
import { GhostConnection } from '../ghost/GhostConnection';
import { GhostPublisher, GhostState, articleHash, PublishArticle } from '../ghost/GhostPublisher';
import { ArticleAssets, imageRefs, mapImages } from '../ghost/ArticleAssets';
import { documentFromMarkdown, documentHtml, documentMarkdown, validateDocument } from '../writing/ArticleDocument';
import { separateArticleTitle } from '../writing/ArticleContent';
import * as vscode from 'vscode';
import * as path from 'path';
import { articleHtml, taggedMarkdown } from '../writing/ArticleExport';
import { normalizeExportTags } from '../settings/ExportTags';
import { checkInputSize } from '../writing/InputLimits';
import { WRITING_MODES, WritingMode, WRITING_STYLES, WritingStyle, writingInstructions } from '../writing/WritingStyle';
import { isWritingModel, selectedWritingModel } from '../writing/WritingModels';
import { randomBytes, randomUUID } from 'crypto';
import { storageManager } from '../storage/StorageManager';
import { readSavedFileHistory } from '../storage/SavedFileHistory';
import { ServiceConnection, ServiceError } from '../writing/ServiceConnection';
import { JobRouter, JobTarget, isServerTarget } from '../writing/JobRouter';
import { articleRequestPlan } from '../writing/MemoOrigins';
import { DraftStore, DraftConflict } from '../writing/DraftStore';
import { ArticleSync } from '../writing/ArticleSync';
import { registerGeneratedArticles, writingActivityContent, WritingActivityContent, WritingActivityStore, WritingActivitySummary } from '../writing/WritingActivity';
import { WindowSession } from '../storage/WindowSession';
import { ConnectionEnvironment } from '../writing/ConnectionSettings';
import {
    WritingDraft, WritingJob,
    mergeResult,
    newDraft,
    sourceFor,
    writingSourceFor,
    preparationSource, memoTailStart, memoSnapshotIndex, appendMemoResult,
    validatePlan,
    historyFingerprint, preparationBaseRevision,
    articleVersionKey,
    previousArticleVersions,
} from '../writing/model';
import template from './templates/blogPostMain.html';
import css from './templates/blogPostMain.css';

interface View {
    panel?: vscode.WebviewPanel;
    controls?: Record<string, unknown>;
    sidebarLinked?: boolean;
    sidebarDismissed?: boolean;
    sidebarAvailable?: boolean;
    draft: WritingDraft;
    queue: Promise<unknown>;
    task?: Promise<void>;
    previousMemoHistory?: { history: FileHistory; fingerprint: string };
    memoRetryAt?: number;
    error: string;
    errorId?: string;
    openDecision?: string;
    openErrorId?: string;
    errorRetry?: 'prepare' | 'generate' | 'retry';
    progress: number;
    ready: boolean;
    partial?: string;
    watcher?: AbortController;
    announced?: string;
    editable: boolean;
    sync?: { dispose(): void };
    ownerCheck?: NodeJS.Timeout;
    ghost?: GhostState;
    ghostArticle?: string;
    activity?: WritingActivityContent;
    activityVersion?: number;
}
export class BlogPostManager {
    public static readonly viewType = 'psb.blogPost';
    private static views = new Map<string, View>();
    private static openings = new Map<string, Promise<void>>();
    private static store: DraftStore;
    private static articleSync: ArticleSync;
    private static activity: WritingActivityStore;
    private static ghost: GhostConnection;
    private static publisher: GhostPublisher;
    private static assets: ArticleAssets;
    private static exports = new Set<Promise<void>>();
    private static ghostUploads = new Map<string, Promise<void>>();
    private static memoQueue: MemoPreparationQueue;
    private static pendingMemos: PendingMemos;
    private static get autoMemos() {
        return !this.closing && backendRequests.enabled && vscode.workspace.getConfiguration('psb').get('prepareOnReview', true);
    }
    private static jobs: JobRouter;
    private static connection: ServiceConnection;
    private static loads = new Map<string, Promise<View | undefined>>();
    private static closing = false;
    private static updates = new vscode.EventEmitter<string>();
    static readonly onDidChange = this.updates.event;
    private static sidebarVisible = false;
    private static controlsChanged = new vscode.EventEmitter<void>();
    static readonly onDidChangeControls = this.controlsChanged.event;

    private static get writingAllowed() { return configManager.contest?.writing ?? true; }
    private static get showAdvancedWritingViews() { return vscode.workspace.getConfiguration('psb').get('showAdvancedWritingViews', false); }

    private static checkWritingAccess(restoredPanel?: vscode.WebviewPanel) {
        if (this.writingAllowed) return true;
        if (restoredPanel) restoredPanel.dispose();
        else void vscode.window.showInformationMessage('대회 모드에서 글쓰기 화면 진입을 차단했습니다.');
        return false;
    }

    static get sidebarWriter() {
        const active = [...this.views.values()].find(view => view.panel?.active && view.sidebarLinked);
        if (!active?.controls) return undefined;
        const { filePath } = active.draft;
        return { filePath, fileName: path.basename(filePath), controls: active.controls };
    }

    static setSidebarVisible(visible: boolean) {
        this.sidebarVisible = visible;
        this.syncSidebar();
    }

    static showSidebarHome(filePath: string) {
        const view = this.views.get(filePath);
        if (!view?.panel?.active || !view.sidebarLinked) return;
        view.sidebarDismissed = true;
        this.syncSidebar();
    }

    private static syncSidebar() {
        const available = !configManager.contest;
        for (const view of this.views.values()) {
            const linked = this.sidebarVisible && available && !!view.panel?.active && !view.sidebarDismissed;
            if (view.sidebarLinked === linked && view.sidebarAvailable === available) continue;
            view.sidebarLinked = linked;
            view.sidebarAvailable = available;
            if (!linked) view.controls = undefined;
            if (view.ready) void view.panel?.webview.postMessage({ type: 'writerSidebar', linked, available });
        }
        this.controlsChanged.fire();
    }

    static sidebarAction(filePath: string, action: string, value?: string) {
        const view = this.views.get(filePath);
        if (view?.sidebarLinked && view.panel?.active && typeof action === 'string') {
            void view.panel.webview.postMessage({ type: 'writerAction', filePath, action, value });
        }
    }
    static async init(context: vscode.ExtensionContext, development: ConnectionEnvironment = {}) {
        this.assets = new ArticleAssets(path.join(context.globalStorageUri.fsPath, 'article-assets'));
        this.ghost = new GhostConnection(context);
        this.publisher = new GhostPublisher(path.join(context.globalStorageUri.fsPath, 'ghost-publications'), this.assets);
        context.subscriptions.push(context.secrets.onDidChange(event => { if (event.key === GhostConnection.key) for (const view of this.views.values()) void this.refreshGhost(view); }));
        this.store = new DraftStore(path.join(context.globalStorageUri.fsPath, 'writing'));
        this.activity = new WritingActivityStore(path.join(context.globalStorageUri.fsPath, 'writing-viewed.json'),
            file => this.store.read(file), (file, changed) => this.store.watch(file, changed), file => this.updates.fire(file));
        context.subscriptions.push(this.activity);
        this.connection = new ServiceConnection(context, development);
        this.articleSync = new ArticleSync(this.store, this.connection);
        void this.articleSync.start();
        this.jobs = new JobRouter(this.connection);
        this.pendingMemos = new PendingMemos(path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'pending-memos.json'),
            error => Logger.warn('메모 대기 목록을 저장하지 못했습니다.', error));
        this.memoQueue = new MemoPreparationQueue((file, review) => this.prepareAutomaticMemo(file, review).catch(error => {
            Logger.warn('자동 메모를 준비하지 못했습니다.', error);
        }), file => this.pendingMemos.finish(file));
        const pendingFiles = await this.pendingMemos.restore().catch(error => {
            Logger.warn('메모 대기 목록을 불러오지 못했습니다.', error);
            return [];
        });
        for (const file of pendingFiles) {
            if (this.autoMemos) this.memoQueue.schedule(file);
            else this.pendingMemos.finish(file);
        }
        context.subscriptions.push(this.memoQueue, storageManager.onDidSaveSnapshot(file => {
            if (!this.autoMemos) return;
            this.pendingMemos.mark(file);
            this.memoQueue.schedule(file);
        }));
        const trackEditor = (editor?: vscode.TextEditor) => {
            this.memoQueue.setEditor(editor && fileWatcher.isTrackedDocument(editor.document) ? editor.document.uri.fsPath : undefined);
        };
        trackEditor(vscode.window.activeTextEditor);
        this.memoQueue.setFocus(vscode.window.state.focused);
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(trackEditor),
            vscode.window.onDidChangeWindowState(state => this.memoQueue.setFocus(state.focused)));
        let requestsEnabled = backendRequests.enabled;
        let writingAllowed = this.writingAllowed;
        context.subscriptions.push(configManager.onDidChange(() => {
            if (!this.autoMemos) this.memoQueue.clear();
            const resume = !requestsEnabled && backendRequests.enabled;
            if (resume) this.articleSync.wake();
            this.syncSidebar();
            if (requestsEnabled === backendRequests.enabled && writingAllowed === this.writingAllowed) return;
            requestsEnabled = backendRequests.enabled;
            writingAllowed = this.writingAllowed;
            for (const view of this.views.values()) {
                if (!requestsEnabled && view.task) {
                    view.watcher?.abort();
                }
                if (resume && (view.editable || view.panel)) this.run(view);
                this.render(view);
            }
        }));
        context.subscriptions.push(
            vscode.commands.registerCommand('psb.connect', () => this.connect()),
            vscode.commands.registerCommand('psb.reviewWritingNotice', () => {
                const active = [...this.views.values()].find(view => view.panel?.active);
                return active?.panel?.webview.postMessage({ type: 'reviewWritingNotice' });
            }),
            vscode.commands.registerCommand('psb.linkArticleJob', () => this.linkArticleJob()),
            vscode.commands.registerCommand('psb.connectGhost', async () => { await this.ghost.configure(); }),
            vscode.commands.registerCommand('psb.sample', async () => {
                if (this.checkWritingAccess()) await this.openPage(context.extensionUri, await storageManager.installSampleHistory());
            }),
            this.connection.changed.event(() => { this.articleSync.wake(); this.updates.fire(''); }),
            this.connection.changed,
            vscode.window.onDidChangeWindowState(() => {
                for (const view of this.views.values()) {
                    if (view.ready) void view.panel?.webview.postMessage({ type: 'writingVisibility', visible: this.writingIsVisible(view) });
                }
            }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('psb.prepareOnReview') && !this.autoMemos) this.memoQueue.clear();
                if (event.affectsConfiguration('psb.showAdvancedWritingViews')) for (const view of this.views.values()) this.render(view);
                if (event.affectsConfiguration('psb.exportTags')) for (const view of this.views.values()) this.sendGhost(view);
            }),
        );
        context.subscriptions.push(
            vscode.window.registerWebviewPanelSerializer(this.viewType, {
                deserializeWebviewPanel: async (panel, saved) => {
                    const filePath = (saved as { filePath?: unknown })?.filePath;
                    if (typeof filePath !== 'string') {
                        panel.dispose();
                        return;
                    }
                    try {
                        await this.openPage(context.extensionUri, filePath, { panel });
                    } catch {
                        panel.dispose();
                    }
                },
            }),
        );
    }
    static async flush() {
        this.closing = true;
        this.memoQueue?.dispose();
        for (const view of this.views.values()) {
            view.sync?.dispose(); clearInterval(view.ownerCheck); view.watcher?.abort();
        }
        await Promise.all([...this.views.values()].map((view) => view.queue));
        await Promise.allSettled([...this.exports]);
        await this.publisher?.close();
        await this.articleSync?.close();
        await this.store?.close();
        await this.pendingMemos?.flush();
    }
    static async connect() {
        await this.connection.configure();
    }
    static async accountLabel() { return (await this.connection.account())?.email || '로그인'; }
    static usage() { return this.connection.usage(); }
    static refreshUsage() { return this.connection.refreshUsage(); }
    static async writingActivity(filePath: string) {
        try { return await this.activity.summary(filePath); }
        catch { return undefined; }
    }
    static async withWritingActivity<T extends { filePath: string }>(logs: T[]) {
        const result: (T & { writingActivity?: WritingActivitySummary })[] = new Array(logs.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, logs.length) }, async () => {
            while (next < logs.length) {
                const index = next++, log = logs[index];
                // Discovered files can have drafts without recorder snapshots. Only
                // watch a discovered file for writing activity once it has a draft.
                if ('source' in log && !this.views.has(log.filePath) && !await this.store.exists(log.filePath)) {
                    result[index] = log;
                    continue;
                }
                result[index] = { ...log, writingActivity: await this.writingActivity(log.filePath) };
            }
        }));
        return result;
    }
    static notices() { return this.connection.notices.current(); }
    static async refreshNotices() { if (backendRequests.enabled) await this.connection.notices.refresh(); }
    static dismissNotice(id: string) { return this.connection.notices.dismiss(id); }
    static showUsage() { return this.connection.showUsage(); }
    static async preparationStatus(filePath: string) {
        const view = this.views.get(filePath);
        const draft = view?.draft ?? await this.store.read(filePath);
        if (view?.error) return '글쓰기 준비를 다시 시도할 수 있어요.';
        if (draft?.pending) {
            return draft.plan && draft.pending.request.priority === 'prefetch'
                ? '기존 메모에 최근 변경을 반영하고 있어요…' : 'AI가 글쓰기 내용을 준비하고 있어요…';
        }
        if (!draft?.plan) return '글쓰기에서 메모를 생성할 수 있어요.';
        if (draft.candidate?.plan) return '글쓰기에서 새 메모를 확인할 수 있어요.';
        const history = await storageManager.getFileHistory(filePath);
        const saved = draft.history.snapshots.at(-1), latest = history?.snapshots.at(-1);
        if (history && latest && latest.hash !== saved?.hash) {
            if (memoTailStart(draft, history) === undefined) return '기존 메모가 저장돼 있어요. 최근 기록은 메모 다시 생성으로 정리할 수 있어요.';
            if (this.automaticMemoDue(history, true, draft) !== undefined) return '기존 메모가 저장돼 있어요. 최근 변경은 아직 반영되지 않았어요.';
        }
        return '글쓰기 준비가 끝났어요.';
    }
    private static async loadView(filePath: string, discoveredLanguage?: string): Promise<View | undefined> {
        if (this.views.has(filePath)) return this.views.get(filePath);
        const pending = this.loads.get(filePath);
        if (pending) {
            const view = await pending;
            if (view || !discoveredLanguage) return view;
            return this.loadView(filePath, discoveredLanguage);
        }
        const loading = (async () => {
            let initial = await this.store.read(filePath);
            if (!initial) {
                const history = await storageManager.getFileHistory(filePath);
                if (history?.snapshots.length) initial = newDraft(history);
                else if (discoveredLanguage) {
                    initial = newDraft(await readSavedFileHistory(filePath, discoveredLanguage));
                    initial.fromSavedFile = true;
                } else return undefined;
            }
            const draft = await this.store.open(initial);
            const view: View = { draft, editable: this.store.owns(draft), queue: Promise.resolve(), error: '', progress: 0, ready: false };
            this.views.set(filePath, view);
            view.sync = this.store.watch(filePath, () => { void this.enqueue(view, () => this.refresh(view)).catch(() => {}); });
            view.ownerCheck = setInterval(() => {
                if (view.panel && !view.editable) void this.enqueue(view, () => this.refresh(view)).catch(() => {});
            }, 1500);
            view.ownerCheck.unref();
            return view;
        })().finally(() => this.loads.delete(filePath));
        this.loads.set(filePath, loading);
        return loading;
    }
    static prepareOnReview(filePath: string) {
        if (this.autoMemos) this.memoQueue.schedule(filePath, true);
    }

    private static automaticMemoDue(history: FileHistory, review: boolean, draft?: WritingDraft) {
        if (draft?.candidate) return;
        const declined = draft?.declinedMemo, last = history.snapshots.at(-1);
        if (declined && declined.historyId === history.id && declined.timestamp === last?.timestamp && declined.hash === last.hash) return;
        const start = draft ? memoTailStart(draft, history) : 0;
        if (start === undefined || start >= history.snapshots.length) return;
        const read = (index: number) => storageManager.reconstructFileContent(history, index);
        const before = start ? read(start - 1) : history.memoBaseline === null ? read(0) : history.memoBaseline;
        const after = read(history.snapshots.length - 1);
        if (after !== null && meritsAutomaticMemo(before ?? '', after, history.language)) {
            return review || !draft?.plan ? 0 : (draft.lastPreparation?.at ?? 0) + MEMO_COOLDOWN;
        }
    }

    private static async prepareAutomaticMemo(filePath: string, review: boolean) {
        if (!this.autoMemos || !await this.connection.account()) return;
        const history = await storageManager.getFileHistory(filePath);
        if (!history?.snapshots.length) return;
        const saved = await this.store.read(filePath);
        if (!saved?.pending) {
            const due = this.automaticMemoDue(history, review, saved);
            if (due === undefined) return;
            if (due > Date.now()) return { cooldown: due };
        }
        if (!this.autoMemos) return;
        const view = await this.loadView(filePath);
        if (!view) return;
        let retryAt: number | { cooldown: number } | undefined;
        let joined = false;
        try {
            await this.enqueue(view, async () => {
                await this.refresh(view, true);
                if (!this.autoMemos) return;
                if (!view.editable) { retryAt = Date.now() + MEMO_COOLDOWN; return; }
                if (view.draft.pending) {
                    joined = true;
                    if (!view.error) this.run(view);
                    return;
                }
                const due = this.automaticMemoDue(history, review, view.draft);
                if (due === undefined || due > Date.now()) { retryAt = due && { cooldown: due }; return; }
                await this.start(view, 'prepare_blog', undefined, true, history);
            });
            // Job completion itself uses the draft queue. Await it outside the lock.
            await view.task;
            if (view.memoRetryAt) return view.memoRetryAt;
            if (joined && !view.draft.pending && !view.error) retryAt = Date.now() + 1;
            return retryAt;
        } finally {
            await this.enqueue(view, async () => {
                if (view.panel || view.draft.pending || view.task || this.openings.has(filePath)) return;
                if (view.editable) await this.store.release(filePath);
                if (view.panel || this.openings.has(filePath)) return;
                view.sync?.dispose();
                clearInterval(view.ownerCheck);
                this.views.delete(filePath);
            });
        }
    }
    public static async openPage(
        extensionUri: vscode.Uri,
        filePath: string,
        options: { panel?: vscode.WebviewPanel; language?: string } = {},
    ) {
        if (!this.checkWritingAccess(options.panel)) return;
        if (!options.panel) await vscode.commands.executeCommand('psb.sidebar.focus', { preserveFocus: true });
        const opening = this.openings.get(filePath);
        if (opening) {
            await opening;
            if (this.checkWritingAccess(options.panel)) this.views.get(filePath)?.panel?.reveal();
            return;
        }
        const operation = this.openPageInternal(extensionUri, filePath, options.panel, options.language).finally(() =>
            this.openings.delete(filePath),
        );
        this.openings.set(filePath, operation);
        await operation;
    }
    private static async openPageInternal(
        extensionUri: vscode.Uri,
        filePath: string,
        restoredPanel?: vscode.WebviewPanel,
        discoveredLanguage?: string,
    ) {
        await fileWatcher.flushFile(filePath);
        const view = await this.loadView(filePath, discoveredLanguage);
        if (!this.checkWritingAccess(restoredPanel)) return;
        if (view?.panel && !restoredPanel) {
            view.sidebarDismissed = false;
            view.panel.reveal();
            this.syncSidebar();
            this.prepareOnReview(filePath);
            return;
        }
        if (!view) {
            void vscode.window.showInformationMessage('아직 기록이 없습니다. 파일을 한 번 저장해 주세요.');
            restoredPanel?.dispose();
            return;
        }
        const current = view;
        const panel =
            restoredPanel ||
            vscode.window.createWebviewPanel(
                this.viewType,
                `글 만들기 · ${path.basename(filePath)}`,
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: true },
            );
        current.panel = panel;
        current.openDecision = undefined;
        current.openErrorId = undefined;
        current.sidebarDismissed = false;
        current.ready = false;
        current.controls = undefined;
        this.syncSidebar();
        panel.onDidChangeViewState(() => {
            if (!panel.active) current.sidebarDismissed = false;
            this.syncSidebar();
            if (current.ready) void panel.webview.postMessage({ type: 'writingVisibility', visible: this.writingIsVisible(current) });
        });
        const webviews = vscode.Uri.joinPath(extensionUri, 'dist', 'webviews');
        panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(this.assets.directory), webviews] };
        panel.onDidDispose(() => {
            if (current.panel === panel) {
                current.panel = undefined;
                current.ready = false;
                current.controls = undefined;
                this.syncSidebar();
                if (!current.draft.pending) {
                    void this.enqueue(current, async () => {
                        if (current.panel) return;
                        await this.store.release(filePath);
                        await this.refresh(current);
                    }).catch(() => {});
                }
            }
        });
        panel.webview.onDidReceiveMessage((message) => {
            if (current.panel !== panel) return;
            if (message?.type === 'showWritingDecision') {
                this.showWritingDecision(current, panel, message);
                return;
            }
            if (message?.type === 'reviewWritingError') {
                if (current.openErrorId && current.openErrorId === current.errorId) void vscode.commands.executeCommand('notifications.showList');
                else if (current.error && current.errorRetry) {
                    this.notifyError(current, current.error, current.errorRetry);
                    this.render(current);
                } else vscode.window.setStatusBarMessage('확인할 글쓰기 알림이 없습니다.', 3000);
                return;
            }
            if (message?.type === 'editorError') {
                if (current.panel === panel && typeof message.message === 'string' && message.message) {
                    void vscode.window.showErrorMessage(message.message.slice(0, 2000));
                }
                return;
            }
            if (message?.type === 'openWriterSidebar') {
                if (current.panel === panel && panel.active && !configManager.contest) {
                    current.sidebarDismissed = false;
                    this.syncSidebar();
                    void vscode.commands.executeCommand('psb.sidebar.focus').then(undefined, () =>
                        panel.webview.postMessage({ type: 'writerSidebar', linked: false, available: false }));
                }
                return;
            }
            if (message?.type === 'writerControls') {
                if (current.panel === panel && message.controls && typeof message.controls === 'object') {
                    current.controls = message.controls;
                    if (current.sidebarLinked) this.controlsChanged.fire();
                }
                return;
            }
            void this.enqueue(current, async () => {
                try {
                    const handled = await this.handle(current, message);
                    void panel.webview.postMessage({ type: handled === false ? 'obsoleteAction' : 'ack', id: message?.id });
                } catch (error) {
                    if (error instanceof DraftConflict) await this.refresh(current);
                    const text = error instanceof Error ? error.message : String(error);
                    // An image failure rejects the editor's import promise, which reports it once.
                    if (message?.type !== 'importImage') {
                        const retry = ['prepare', 'generate', 'retry'].includes(message?.type) ? message.type : undefined;
                        this.notifyError(current, text, retry);
                    }
                    void panel.webview.postMessage({
                        type: 'saveError',
                        id: message?.id,
                        message: text,
                    });
                }
                this.render(current);
            });
        });
        const nonce = randomBytes(24).toString('base64');
        panel.webview.html = template
            .replace(
                '{{csp}}',
                `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${panel.webview.cspSource} https: data:;`,
            )
            .replace('{{styles}}', () => `<style nonce="${nonce}">${css}</style>`)
            .replace('{{script}}', () => `<script nonce="${nonce}" src="${panel.webview.asWebviewUri(vscode.Uri.joinPath(webviews, 'writer.js'))}"></script>`);
    }
    private static showWritingDecision(view: View, panel: vscode.WebviewPanel, message: {
        kind: string; decisionId: string; candidateId?: string; editToken?: string;
    }) {
        const { kind, decisionId, candidateId, editToken } = message;
        if (typeof decisionId !== 'string' || !this.writingAllowed || editToken !== view.draft.editor?.token) return;
        if (view.openDecision === decisionId) {
            void vscode.commands.executeCommand('notifications.showList');
            return;
        }
        let prompt: string;
        let actions: Record<string, string>;
        if (kind === 'ownership' && !view.editable) {
            prompt = '다른 창에서 이 글을 편집하고 있습니다.';
            actions = { '이 창에서 편집': 'takeover' };
        } else if (kind === 'recovery' && view.editable) {
            prompt = '이 창에 저장하지 못한 입력이 있습니다. 복구할까요?';
            actions = { '미저장 입력 적용': 'recover' };
        } else if (kind === 'candidate' && view.editable && candidateId && candidateId === view.draft.candidate?.decisionId) {
            prompt = view.draft.candidate.plan ? '새 메모가 준비됐습니다. 적용할까요?' : '새 글이 준비됐습니다. 적용할까요?';
            actions = { '새 결과 적용': 'applyCandidate', '현재 상태 유지': 'discardCandidate' };
        } else return;
        view.openDecision = decisionId;
        void vscode.window.showInformationMessage(`${path.basename(view.draft.filePath)} · ${prompt}`, ...Object.keys(actions)).then(choice => {
            if (view.panel !== panel || view.openDecision !== decisionId) return;
            view.openDecision = undefined;
            if (choice && this.writingAllowed && view.draft.editor?.token === editToken) {
                void panel.webview.postMessage({ type: 'writingDecisionChoice', kind, decisionId, candidateId, editToken, action: actions[choice] });
            }
        });
    }
    private static notifyError(view: View, text: string, retry?: 'prepare' | 'generate' | 'retry') {
        if (this.closing) return;
        const panel = view.panel;
        if (!retry) {
            if (panel) void vscode.window.showErrorMessage(text);
            else Logger.warn(text);
            return;
        }
        view.error = text;
        view.errorRetry = retry;
        const errorId = view.errorId = randomUUID();
        const editToken = view.draft.editor?.token;
        const pendingId = view.draft.pending?.request.requestId;
        if (!view.editable) return;
        const canRetry = panel && this.writingAllowed && backendRequests.enabled;
        view.openErrorId = errorId;
        const actions = canRetry ? (pendingId ? ['다시 시도', '작업 취소'] : ['다시 시도']) : [];
        void vscode.window.showErrorMessage(text, ...actions).then(choice => {
            if (view.openErrorId === errorId) view.openErrorId = undefined;
            if (!choice || this.closing || view.panel !== panel || view.errorId !== errorId || !view.error ||
                view.task || !view.editable || !this.writingAllowed || !backendRequests.enabled ||
                view.draft.editor?.token !== editToken || view.draft.pending?.request.requestId !== pendingId) return;
            void panel?.webview.postMessage({ type: 'retryWriting', action: choice === '작업 취소' ? 'discardPending' : retry, errorId, editToken, pendingId });
        });
    }
    private static enqueue(view: View, action: () => Promise<void>) {
        const next = view.queue.then(action);
        view.queue = next.catch((error) => {
            if (error?.name === 'AbortError') return;
            this.notifyError(view, error instanceof Error ? error.message : String(error));
            this.render(view);
        });
        return next;
    }
    private static async refresh(view: View, claim = false) {
        if (this.closing) return;
        let latest = await this.store.read(view.draft.filePath);
        if (!latest) return;
        if ((claim || view.panel) && !this.store.owns(latest) && !await WindowSession.alive(latest.editor?.owner)) latest = await this.store.open(latest);
        if (latest.storageVersion === view.draft.storageVersion && latest.editor?.token === view.draft.editor?.token && latest.syncLabel === view.draft.syncLabel) return;
        const ownershipChanged = latest.editor?.token !== view.draft.editor?.token;
        if (ownershipChanged) {
            view.watcher?.abort(); view.watcher = undefined; view.task = undefined;
            view.partial = ''; view.error = '';
        }
        view.draft = latest;
        view.editable = this.store.owns(latest);
        this.render(view);
        if (view.draft.pending && (view.editable || view.panel)) this.run(view);
    }
    private static writingIsVisible(view: View) {
        return this.writingAllowed && !!view.panel?.visible && !!view.panel.active && vscode.window.state.focused;
    }
    private static render(view: View) {
        if (!view.activity || view.activityVersion !== view.draft.storageVersion) {
            view.activity = this.activity.update(view.draft);
            view.activityVersion = view.draft.storageVersion;
        }
        const announcement = `${view.draft.storageVersion}:${!!view.draft.pending}:${!!view.draft.plan}:${view.error}`;
        if (view.announced !== announcement) { view.announced = announcement; this.updates.fire(view.draft.filePath); }
        if (!view.ready) return;
        const { draft } = view;
        if (view.ghostArticle !== draft.publicationId) {
            view.ghost = undefined;
            void this.refreshGhost(view);
        }
        void view.panel?.webview.postMessage({
            type: 'model',
            filePath: draft.filePath,
            fileName: path.basename(draft.filePath),
            language: draft.history.language,
            activity: view.activity.visible,
            writingVisible: this.writingIsVisible(view),
            writingAllowed: this.writingAllowed,
            showAdvancedWritingViews: this.showAdvancedWritingViews,
            backendEnabled: backendRequests.enabled,
            localImageBase: view.panel.webview.asWebviewUri(vscode.Uri.file(this.assets.directory)).toString() + '/',
            plan: draft.plan,
            instructions: draft.instructions,
            writingModel: selectedWritingModel(draft.writingModel),
            writingMode: draft.writingMode ?? 'evolution',
            writingStyle: draft.writingStyle ?? 'plain',
            customStyle: draft.customStyle ?? '',
            title: draft.title,
            markdown: draft.markdown,
            document: draft.document,
            images: this.imageSources(view, draft),
            ghost: this.ghostState(view),
            syncLabel: draft.syncLabel,
            hasSyncFailures: draft.hasSyncFailures,
            revision: draft.revision,
            editable: view.editable,
            editToken: draft.editor?.token,
            count: draft.history.snapshots.length,
            historyVersion: draft.fingerprint,
            times: draft.history.snapshots.map((s) => s.timestamp),
            pending: !!draft.pending,
            updatingMemos: draft.pending?.request.priority === 'prefetch' && !!draft.plan,
            pendingId: draft.pending?.request.requestId,
            pendingKind: draft.pending?.request.kind,
            running: !!view.task,
            progress: view.progress,
            error: view.error,
            errorId: view.errorId,
            candidate: !!draft.candidate,
            candidateId: draft.candidate?.decisionId,
            planNotices: draft.planNotices,
            articleNotices: draft.articleNotices,
            candidateNotices: draft.candidate?.notices,
            versions: previousArticleVersions(draft).map((v) => ({ id: articleVersionKey(v), at: v.at, title: v.title })),
            streamMarkdown: view.partial,
        });
    }
    private static imageSources(view: View, article: PublishArticle): Record<string, string> {
        if (!view.panel) return {};
        return Object.fromEntries(imageRefs(article.document || documentFromMarkdown(article.markdown)).filter(src => /^psb-image:[a-f0-9]{64}$/.test(src)).map(src => [src, view.panel!.webview.asWebviewUri(vscode.Uri.file(this.assets.file(src))).toString()]));
    }
    private static ghostState(view: View) {
        let synced = false;
        try { synced = view.ghost?.localHash === articleHash({ ...view.draft, tags: this.exportTags() }); }
        catch { /* Invalid settings remain editable; an export reports the validation error. */ }
        return view.ghost && { ...view.ghost, synced };
    }
    private static exportTags(): string[] {
        return normalizeExportTags(vscode.workspace.getConfiguration('psb').get('exportTags', []));
    }
    private static sendGhost(view: View) { void view.panel?.webview.postMessage({ type: 'ghost', state: this.ghostState(view) }); }
    private static publication(draft: WritingDraft) {
        if (!draft.publicationId) throw new Error('글의 게시 정보를 찾을 수 없습니다.');
        const id = draft.publicationId;
        if (!id.startsWith('legacy-')) return { id };
        const tags = this.exportTags();
        const legacyArticles = [draft, ...draft.articleVersions].filter(item => item.publicationId?.startsWith('legacy-'))
            .map(item => ({ id: item.publicationId!, article: { title: item.title, markdown: item.markdown, document: item.document, tags } }));
        return { id, legacyArticles };
    }
    private static async refreshGhost(view: View) {
        const id = view.ghostArticle = view.draft.publicationId;
        try {
            const identity = this.publication(view.draft);
            const state = await this.publisher.state(await this.ghost.get(), view.draft.filePath, identity);
            if (view.draft.publicationId !== id) return;
            view.ghost = state;
        } catch {
            if (view.draft.publicationId !== id) return;
            view.ghost = { connected: false, error: 'Ghost 연결 정보를 확인해 주세요.' };
        }
        this.sendGhost(view);
    }
    private static automaticGhostMode(): 'draft' | 'publish' | undefined {
        const config = vscode.workspace.getConfiguration('psb');
        const mode = config.get<string>('ghostAutoUploadMode', 'draft');
        return config.get<boolean>('ghostAutoUpload', false) === true && (mode === 'draft' || mode === 'publish') ? mode : undefined;
    }
    private static autoUpload(view: View) {
        const mode = this.automaticGhostMode();
        if (!mode || this.closing || !view.editable) return;
        try {
            const article = structuredClone({ title: view.draft.title, markdown: view.draft.markdown, document: view.draft.document, tags: this.exportTags() });
            this.uploadGhost(view, article, mode === 'publish', true);
        } catch (error) {
            const message = error instanceof Error ? error.message : '내보내기 설정을 확인해 주세요.';
            view.ghost = { ...(view.ghost || { connected: false }), error: 'Ghost 자동 업로드 실패: ' + message };
            this.sendGhost(view);
            void vscode.window.showWarningMessage('Ghost 자동 업로드 실패: ' + message);
        }
    }
    private static uploadGhost(view: View, article: PublishArticle, publish: boolean, automatic = false) {
        const identity = this.publication(view.draft);
        const filePath = view.draft.filePath, previous = this.ghostUploads.get(filePath);
        if (!automatic && previous) throw new Error('Ghost에 저장 중입니다.');
        const operation = (async () => {
            if (previous) await previous;
            // A setting change can cancel an upload that has not started yet.
            if (automatic && this.automaticGhostMode() !== (publish ? 'publish' : 'draft')) return;
            if (view.draft.publicationId === identity.id) {
                view.ghost = { ...(view.ghost || { connected: false }), busy: true }; this.sendGhost(view);
            }
            try {
                const settings = await this.ghost.get() || (!automatic ? await this.ghost.configure() : undefined);
                if (!settings) {
                    if (automatic) throw new Error('설정의 Ghost 연결 / 변경에서 먼저 연결해 주세요. 글은 로컬에 저장되어 있습니다.');
                    await this.refreshGhost(view); return;
                }
                if (!automatic && publish && await vscode.window.showWarningMessage(`“${article.title}”을 ${new URL(settings.url).host}에 공개 게시할까요?`, { modal: true }, '공개 게시') !== '공개 게시') { await this.refreshGhost(view); return; }
                const priorState = await this.publisher.state(settings, filePath, identity);
                if (view.draft.publicationId === identity.id) {
                    view.ghost = { ...priorState, busy: true }; this.sendGhost(view);
                }
                if (automatic && this.automaticGhostMode() !== (publish ? 'publish' : 'draft')) { await this.refreshGhost(view); return; }
                const state = await this.publisher.publish(settings, filePath, article, publish, { draftOnly: automatic && !publish, identity });
                if (view.draft.publicationId !== identity.id) return;
                view.ghost = state;
                if (automatic) {
                    vscode.window.setStatusBarMessage(publish ? '글을 완성하고 Ghost에 공개 게시했습니다.' : '글을 완성하고 Ghost에 초안으로 저장했습니다.', 4000);
                }
            } catch (error) {
                await this.refreshGhost(view);
                if (view.draft.publicationId !== identity.id) return;
                const message = error instanceof Error ? error.message : 'Ghost 저장에 실패했습니다.';
                view.ghost = { ...(view.ghost || { connected: false }), busy: false, error: (automatic ? 'Ghost 자동 업로드 실패: ' : '') + message };
                if (automatic) void vscode.window.showWarningMessage('Ghost 자동 업로드 실패: ' + message);
            } finally { this.sendGhost(view); }
        })();
        this.ghostUploads.set(filePath, operation);
        this.exports.add(operation);
        void operation.finally(() => {
            this.exports.delete(operation);
            if (this.ghostUploads.get(filePath) === operation) this.ghostUploads.delete(filePath);
        }).catch(() => {});
    }
    private static async exportContent(article: PublishArticle, html: boolean, uri: vscode.Uri) {
        const doc = article.document || documentFromMarkdown(article.markdown);
        const tags = article.tags || [];
        const refs = imageRefs(doc).filter(src => src.startsWith('psb-image:'));
        if (html) {
            const images = Object.fromEntries(await Promise.all(refs.map(async src => [src, await this.assets.dataUrl(src)])));
            return articleHtml(article.title, article.markdown, documentHtml(doc, images), tags);
        }
        if (!refs.length) return this.markdown(article, tags);
        const folder = path.basename(uri.path, path.extname(uri.path)) + '.assets';
        const target = vscode.Uri.joinPath(uri, '..', folder);
        await vscode.workspace.fs.createDirectory(target);
        const mapped = await mapImages(doc, async src => {
            if (!src.startsWith('psb-image:')) return src;
            const { bytes, mime } = await this.assets.read(src), name = src.slice(10) + '.' + mime.split('/')[1];
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(target, name), bytes);
            return './' + encodeURIComponent(folder) + '/' + name;
        });
        return this.markdown({ title: article.title, markdown: documentMarkdown(mapped), document: mapped }, tags);
    }
    private static async edit(view: View, fields: unknown) {
        if (!fields || typeof fields !== 'object') return;
        const value = fields as Record<string, unknown>,
            draft = view.draft;
        const articleBefore = JSON.stringify([draft.title, draft.markdown, draft.document]);
        const before = JSON.stringify([
            draft.plan,
            draft.instructions,
            draft.writingModel,
            draft.writingMode,
            draft.writingStyle,
            draft.customStyle,
            draft.title,
            draft.markdown, draft.document,
        ]);
        const patch: Record<string, unknown> = {};
        const modelChanged = value.writingModel !== undefined && value.writingModel !== selectedWritingModel(draft.writingModel);
        if (value.writingModel !== undefined) {
            if (!isWritingModel(value.writingModel)) throw new Error('사용할 모델을 선택해 주세요.');
            if (modelChanged) {
                if ((draft.pending || view.task) && draft.pending?.request.priority !== 'prefetch') throw new Error('진행 중인 요청을 마친 뒤 모델을 변경해 주세요.');
            }
            patch.writingModel = value.writingModel;
        }
        for (const [key, limit] of [
            ['instructions', 12000],
            ['customStyle', 2000],
            ['title', 300],
            ['markdown', 150000],
        ] as const) {
            if (value[key] !== undefined) {
                if (typeof value[key] !== 'string' || (value[key] as string).length > limit) {
                    throw new Error('입력 내용이 너무 깁니다.');
                }
                patch[key] = value[key];
            }
        }
        if (value.writingMode !== undefined) {
            if (!WRITING_MODES.includes(value.writingMode as WritingMode)) throw new Error('글 구성 모드를 선택해 주세요.');
            patch.writingMode = value.writingMode;
        }
        if (value.writingStyle !== undefined) {
            if (!WRITING_STYLES.includes(value.writingStyle as WritingStyle)) throw new Error('글의 문체를 선택해 주세요.');
            patch.writingStyle = value.writingStyle;
        }
        if (value.plan !== undefined) {
            patch.plan = validatePlan(value.plan, draft.history.snapshots.length, true);
        }
        if (value.document) patch.document = validateDocument(value.document);
        else if (typeof value.markdown === 'string' && (value.document === null || value.markdown !== draft.markdown)) patch.document = undefined;
        Object.assign(draft, separateArticleTitle({ ...draft, ...patch }));
        if (
            before !== JSON.stringify([draft.plan, draft.instructions, draft.writingModel, draft.writingMode, draft.writingStyle, draft.customStyle, draft.title, draft.markdown, draft.document])
        ) {
            draft.revision++;
            draft.updatedAt = Date.now();
        }
        if (articleBefore === JSON.stringify([draft.title, draft.markdown, draft.document])) await this.store.save(draft);
        else await this.saveArticleEdit(draft);
    }
    private static async linkArticleJob() {
        const view = [...this.views.values()].find(view => view.panel?.active && view.editable);
        if (!view?.draft.markdown || view.draft.articleOrigin) {
            void vscode.window.showInformationMessage('서버 작업에 연결할 기존 로컬 글을 편집 화면에서 열어 주세요.');
            return;
        }
        const target = await this.jobs.target();
        const picked = await this.connection.pickJob(target.base, target.owner,
            '현재 글과 이후 편집본을 저장할 서버 작업 선택 · ' + target.owner, path.basename(view.draft.filePath));
        if (!picked) return;
        await this.enqueue(view, async () => {
            if (!view.editable || view.draft.articleOrigin || this.connection.base !== target.base ||
                (await this.connection.saved(target.base))?.user.id !== target.owner) return;
            view.draft.articleOrigin = { ...target, jobId: picked.id };
            await this.saveArticleEdit(view.draft);
        });
    }
    private static async saveArticleEdit(draft: WritingDraft) {
        const origin = draft.articleOrigin;
        if (!origin || origin.base !== this.connection.base || (await this.connection.saved(origin.base))?.user.id !== origin.owner) {
            draft.syncEditId = 'local';
            await this.store.save(draft);
            return;
        }
        draft.lastArticleEditAt = Math.max(Date.now(), (draft.lastArticleEditAt ?? 0) + 1);
        const edit = { origin, id: randomUUID(), editedAt: draft.lastArticleEditAt, title: draft.title, markdown: draft.markdown, document: draft.document };
        draft.syncEditId = edit.id;
        await this.store.save(draft, edit);
        this.articleSync.schedule(draft.filePath);
    }
    private static async handle(view: View, message: any) {
        if (
            !message ||
            typeof message !== 'object' ||
            typeof message.type !== 'string' ||
            JSON.stringify(message).length > (message.type === 'importImage' ? 14_100_000 : 1_600_000)
        ) {
            throw new Error('화면 요청을 확인할 수 없습니다.');
        }
        await this.refresh(view);
        if (['applyCandidate', 'discardCandidate'].includes(message.type) &&
            (!view.draft.candidate || view.draft.candidate.decisionId !== message.candidateId)) return false;
        if (message.type === 'takeover' && (view.editable || message.editToken !== view.draft.editor?.token)) return;
        if (message.errorId && (!view.error || message.errorId !== view.errorId || view.task ||
            message.pendingId !== view.draft.pending?.request.requestId)) return false;
        if (!this.writingAllowed && !['ready', 'save', 'viewedWriting'].includes(message.type)) {
            throw new Error('대회 모드에서 글쓰기 화면 진입을 차단했습니다.');
        }
        const reading = ['ready', 'takeover', 'viewedWriting', 'diff', 'preview', 'previewVersion', 'export', 'copy', 'openLink', 'connect', 'ghostConnect', 'ghostOpen', 'viewSyncFailures'].includes(message.type);
        if (!reading && (!view.editable || message.editToken !== view.draft.editor?.token)) throw new DraftConflict();
        if (message.fields && Array.isArray(message.dirtyKeys)) {
            const fields = Object.fromEntries(Object.entries(message.fields).filter(([key]) => message.dirtyKeys.includes(key)));
            if (fields.plan && message.planHistory && message.planHistory !== view.draft.fingerprint) {
                const previous = view.previousMemoHistory;
                if (previous?.fingerprint !== message.planHistory || !view.draft.plan || !previous) {
                    throw new Error('메모의 기준 기록이 바뀌었습니다. 입력한 내용을 확인해 주세요.');
                }
                const history = previous.history, current = view.draft.history;
                const edited = validatePlan(fields.plan, history.snapshots.length, true);
                const remap = (i: number) => memoSnapshotIndex(history, current, i);
                const last = remap(history.snapshots.length - 1);
                fields.plan = { ...edited, start: remap(edited.start),
                    end: edited.end === history.snapshots.length - 1 ? view.draft.plan.end : remap(edited.end),
                    steps: [...edited.steps.map(step => ({ ...step, start: remap(step.start), end: remap(step.end) })),
                        ...view.draft.plan.steps.filter(step => step.start > last)] };
            }
            message.fields = fields;
        }
        switch (message.type) {
            case 'viewedWriting':
                if (this.writingIsVisible(view)
                    && Array.isArray(message.notes) && Array.isArray(message.articles)
                    && message.notes.length <= 100 && message.articles.length <= 25
                    && [...message.notes, ...message.articles].every(key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key))) {
                    await this.activity.markViewed(view.draft.filePath, { notes: message.notes, articles: message.articles });
                }
                break;
            case 'takeover': {
                view.watcher?.abort(); view.watcher = undefined; view.task = undefined;
                view.draft = await this.store.open(view.draft, true);
                view.editable = true; view.error = '';
                if (view.draft.pending) this.run(view);
                else this.prepareOnReview(view.draft.filePath);
                break;
            }
            case 'ready':
                view.ready = true;
                void view.panel?.webview.postMessage({ type: 'writerSidebar', linked: !!view.sidebarLinked, available: view.sidebarAvailable });
                void this.connection.refreshUsage();
                await this.refreshGhost(view);
                this.render(view);
                if (view.draft.pending) this.run(view);
                else this.prepareOnReview(view.draft.filePath);
                break;
            case 'checkWritingModel': {
                if (!isWritingModel(message.writingModel)) throw new Error('사용할 모델을 선택해 주세요.');
                // Balance checks must not hold up editing, saving, or a newer selection.
                const panel = view.panel;
                const reply = (result: { allowed: boolean; message?: string }) => {
                    void panel?.webview.postMessage({ type: 'writingModelChecked', id: message.id,
                        editToken: message.editToken, writingModel: message.writingModel, ...result });
                };
                void this.connection.checkWritingModel(message.writingModel).then(reply, () => reply({
                    allowed: false, message: '사용 가능 여부를 확인하지 못해 이전 모델을 유지했습니다. 다시 선택해 주세요.',
                }));
                break;
            }
            case 'save':
                await this.edit(view, message.fields);
                break;
            case 'prepare':
                await this.edit(view, message.fields);
                await this.start(view, 'prepare_blog');
                break;
            case 'generate':
                await this.edit(view, message.fields);
                await this.start(view, 'write_blog');
                break;
            case 'retry':
                await this.edit(view, message.fields);
                if (view.draft.pending) this.run(view, true);
                else await this.start(view, view.draft.plan ? 'write_blog' : 'prepare_blog');
                break;
            case 'cancel':
                await this.cancelPending(view);
                break;
            case 'discardPending':
                await this.edit(view, message.fields);
                if (view.task) throw new Error('작업을 취소한 뒤 다시 시도해 주세요.');
                if (view.draft.pending?.jobId && isServerTarget(view.draft.pending.target) && !view.draft.pending.apiUrl) {
                    try { await this.jobs.cancel(view.draft.pending.jobId, view.draft.pending.target); }
                    catch (error) { if (!(error instanceof ServiceError && error.status === 404)) throw error; }
                }
                delete view.draft.pending;
                view.error = '';
                await this.store.save(view.draft);
                break;
            case 'applyCandidate':
                await this.edit(view, message.fields);
                if (view.draft.candidate) {
                    const article = typeof view.draft.candidate.markdown === 'string' && typeof view.draft.candidate.title === 'string';
                    mergeResult(view.draft, view.draft.candidate, view.draft.revision);
                    delete view.draft.candidate;
                    await this.store.save(view.draft);
                    if (article) this.autoUpload(view);
                    this.prepareOnReview(view.draft.filePath);
                }
                break;
            case 'discardCandidate': {
                await this.edit(view, message.fields);
                const history = view.draft.candidate?.plan && view.draft.candidate.history, last = history?.snapshots.at(-1);
                if (history && last) view.draft.declinedMemo = { historyId: history.id, timestamp: last.timestamp, hash: last.hash };
                delete view.draft.candidate;
                await this.store.save(view.draft);
                this.prepareOnReview(view.draft.filePath);
                break;
            }
            case 'diff': {
                const index = Number(message.index),
                    source = sourceFor(view.draft.history, index, index);
                void view.panel?.webview.postMessage({
                    type: 'diff',
                    index,
                    text: source.changes[0].diff,
                });
                break;
            }
            case 'preview': {
                if (view.editable && message.editToken === view.draft.editor?.token) await this.edit(view, message.fields);
                if (!this.showAdvancedWritingViews) break;
                const html = documentHtml(view.draft.document || documentFromMarkdown(view.draft.markdown), this.imageSources(view, view.draft));
                void view.panel?.webview.postMessage({ type: 'preview', html });
                break;
            }
            case 'previewVersion': {
                const version = this.version(view.draft, message.versionId);
                void view.panel?.webview.postMessage({
                    type: 'versionPreview', versionId: message.versionId, title: version.title, notices: version.notices,
                    html: documentHtml(version.document || documentFromMarkdown(version.markdown), this.imageSources(view, version)),
                });
                break;
            }
            case 'export': {
                if (message.format && !['markdown', 'html'].includes(message.format)) throw new Error('내보낼 파일 형식을 선택해 주세요.');
                if (!message.versionId && view.editable && message.editToken === view.draft.editor?.token) await this.edit(view, message.fields);
                const article = structuredClone({ ...(message.versionId ? this.version(view.draft, message.versionId) : view.draft), tags: this.exportTags() });
                const html = message.format === 'html';
                const uri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(
                        path.join(
                            path.dirname(view.draft.filePath),
                            path.basename(view.draft.filePath, path.extname(view.draft.filePath)) +
                                (html ? '.html' : '.md'),
                        ),
                    ),
                    filters: html ? { HTML: ['html'] } : { Markdown: ['md'] },
                });
                if (uri) {
                    await vscode.workspace.fs.writeFile(
                        uri,
                        Buffer.from(await this.exportContent(article, html, uri)),
                    );
                    vscode.window.setStatusBarMessage(`${html ? 'HTML' : 'Markdown'} 파일로 저장했습니다.`, 3000);
                }
                break;
            }
            case 'copy':
                if (!message.versionId && view.editable && message.editToken === view.draft.editor?.token) await this.edit(view, message.fields);
                await vscode.env.clipboard.writeText(this.markdown(message.versionId ? this.version(view.draft, message.versionId) : view.draft));
                vscode.window.setStatusBarMessage('글을 복사했습니다.', 3000);
                break;
            case 'restore': {
                const version = this.version(view.draft, message.versionId);
                await this.edit(view, message.fields);
                mergeResult(
                    view.draft,
                    version,
                    view.draft.revision,
                );
                await this.saveArticleEdit(view.draft);
                vscode.window.setStatusBarMessage('선택한 버전을 적용했습니다.', 3000);
                break;
            }
            case 'openLink': {
                const url = new URL(String(message.url));
                if (['http:', 'https:', 'mailto:'].includes(url.protocol)) {
                    if (url.protocol !== 'mailto:') backendRequests.requireEnabled();
                    await vscode.env.openExternal(vscode.Uri.parse(url.href));
                }
                break;
            }
            case 'importImage': {
                if (typeof message.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)) throw new Error('이미지 데이터를 확인해 주세요.');
                const src = await this.assets.put(Buffer.from(message.data, 'base64'));
                void view.panel?.webview.postMessage({ type: 'imageReady', id: message.id, src, preview: view.panel.webview.asWebviewUri(vscode.Uri.file(this.assets.file(src))).toString() });
                break;
            }
            case 'viewSyncFailures': {
                const origin = view.draft.articleOrigin;
                if (!origin) break;
                const failed = await this.store.rejectedEdits(view.draft.filePath, origin);
                const chosen = await vscode.window.showQuickPick(failed.reverse().map(edit => ({
                    label: edit.title || '제목 없는 글',
                    description: new Date(edit.editedAt).toLocaleString() + (edit.rejected === 409 ? ' · 서버 버전 충돌' : ' · 서버 저장 실패'),
                    edit,
                })), { title: '동기화하지 못한 로컬 버전 열기' });
                if (chosen) {await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({
                    language: 'markdown', content: this.markdown(chosen.edit, []),
                }));}
                break;
            }
            case 'ghostConnect':
                await this.ghost.configure(); await this.refreshGhost(view); break;
            case 'ghostOpen': {
                await this.refreshGhost(view);
                backendRequests.requireEnabled();
                if (view.ghost?.editorUrl) await vscode.env.openExternal(vscode.Uri.parse(view.ghost.editorUrl));
                break;
            }
            case 'ghostSave': case 'ghostPublish': {
                await this.edit(view, message.fields);
                // Capture before any prompt/network request; subsequent edits stay local and responsive.
                const article = structuredClone({ title: view.draft.title, markdown: view.draft.markdown, document: view.draft.document, tags: this.exportTags() });
                this.uploadGhost(view, article, message.type === 'ghostPublish');
                break;
            }
            case 'connect':
                await this.connect();
                break;
            default:
                throw new Error('지원하지 않는 화면 요청입니다.');
        }
    }
    private static version(draft: WritingDraft, id: unknown) {
        const version = typeof id === 'string' && draft.articleVersions.find(v => articleVersionKey(v) === id);
        if (!version) throw new Error('이전 글을 찾을 수 없습니다. 버전을 다시 선택해 주세요.');
        return version;
    }
    private static markdown(draft: Pick<WritingDraft, 'title' | 'markdown'> & Partial<Pick<WritingDraft, 'plan' | 'document'>>, tags = this.exportTags()) {
        return taggedMarkdown(`# ${draft.title || draft.plan?.title || '풀이 기록'}\n\n${draft.markdown}\n`, tags);
    }
    private static async start(view: View, kind: 'prepare_blog' | 'write_blog', target?: JobTarget, prefetch = false, reviewedHistory?: FileHistory) {
        if (!view.editable) return;
        backendRequests.requireEnabled();
        const draft = view.draft;
        const background = draft.pending?.request.priority === 'prefetch' && !prefetch ? draft.pending : undefined;
        if (!background && (draft.pending || view.task)) return;
        let history = draft.history;
        if (kind === 'prepare_blog') {
            const recorded = reviewedHistory ?? await storageManager.getFileHistory(draft.filePath);
            if (recorded?.snapshots.length) history = recorded;
            else if (draft.fromSavedFile) history = await readSavedFileHistory(draft.filePath, history.language);
        }
        const plan = kind === 'write_blog' ? articleRequestPlan(draft) : undefined;
        if (kind === 'write_blog' && !plan) {
            throw new Error('AI가 풀이 흐름을 준비한 뒤 글을 만들 수 있습니다.');
        }
        const tailStart = prefetch ? memoTailStart(draft, history) : 0;
        if (tailStart === undefined || tailStart >= history.snapshots.length) return;
        const source =
            kind === 'prepare_blog'
                ? preparationSource(history, prefetch, tailStart)
                : writingSourceFor(history, plan!.start, plan!.end, plan!.steps.flatMap((step) => [step.start, step.end]));
        const end = source.changes.at(-1)!.index;
        if (prefetch && end < history.snapshots.length - 1) {
            history = { ...history, snapshots: history.snapshots.slice(0, end + 1) };
            this.pendingMemos.mark(draft.filePath);
            this.memoQueue.schedule(draft.filePath);
        }
        checkInputSize({ source });
        const newSolution = prefetch && tailStart > 0 && looksLikeNewSolution(source.initialCode, source.finalCode, history.language);
        const instructions = prefetch ? '' : writingInstructions(draft);
        target ||= await this.jobs.target(!prefetch);
        backendRequests.requireEnabled();
        if (prefetch && !this.autoMemos) return;
        if (background) {
            background.cancelRequested = true;
            view.watcher?.abort();
            view.watcher = undefined;
            view.task = undefined;
            if (background.jobId && isServerTarget(background.target)) {
                void this.jobs.cancel(background.jobId, background.target).catch(() => {});
            }
            if (this.autoMemos) {
                this.pendingMemos.mark(draft.filePath);
                this.memoQueue.schedule(draft.filePath);
            }
        }
        view.memoRetryAt = undefined;
        draft.pending = {
            target,
            request: {
                kind,
                // The server always prepares memos with its own model; the choice applies to the article only.
                ...(kind === 'write_blog' ? { model: selectedWritingModel(draft.writingModel) } : {}),
                priority: prefetch ? 'prefetch' : 'interactive',
                requestId: randomUUID(),
                supportsAuthorNotices: true,
                source,
                ...(kind === 'write_blog' ? { plan: structuredClone(plan!) } : {}),
                instructions,
            },
            ...(prefetch && draft.plan && !newSolution ? { append: true } : {}),
            baseRevision: newSolution ? -1 : kind === 'prepare_blog' ? preparationBaseRevision(draft, prefetch) : draft.revision,
            ...(kind === 'prepare_blog' ? { history: structuredClone(history) } : {}),
        };
        await this.store.save(draft);
        this.run(view);
    }
    private static async cancelPending(view: View) {
        const pending = view.draft.pending;
        if (!pending) return;
        pending.cancelRequested = true;
        await this.store.save(view.draft);
        if (pending.jobId && isServerTarget(pending.target)) await this.jobs.cancel(pending.jobId, pending.target);
        this.run(view);
    }
    private static run(view: View, retry = false) {
        if (!backendRequests.enabled || this.closing || view.task || !view.draft.pending) return;
        const pending = view.draft.pending;
        view.memoRetryAt = undefined;
        view.error = '';
        view.partial = '';
        view.watcher = new AbortController();
        const controller = view.watcher, signal = controller.signal;
        view.task = Promise.resolve().then(async () => {
            try {
                if (pending.apiUrl || !isServerTarget(pending.target)) {
                    if (!view.editable) return;
                    if (pending.cancelRequested) {
                        await this.enqueue(view, async () => { signal.throwIfAborted(); delete view.draft.pending; await this.store.save(view.draft); });
                        if (view.panel && pending.request.priority !== 'prefetch') vscode.window.setStatusBarMessage('작업을 취소했습니다.', 3000);
                        return;
                    }
                    if (!retry) throw new Error('이전 실행 방식의 작업입니다. 다시 시도하면 현재 서비스로 새 요청을 보냅니다.');
                    const target = await this.jobs.target();
                    delete pending.apiUrl;
                    delete pending.jobId;
                    pending.request.requestId = randomUUID();
                    pending.request.supportsAuthorNotices = true;
                    pending.target = target;
                    await this.enqueue(view, async () => { signal.throwIfAborted(); await this.store.save(view.draft); });
                }
                const target = pending.target;
                const update = (job: WritingJob) => {
                    if (signal.aborted) return;
                    view.progress = job.progress;
                    // Terminal events omit the partial body while the final draft is being saved.
                    if (job.partial !== undefined) view.partial = job.partial;
                    this.render(view);
                };
                if (!view.editable) {
                    if (pending.jobId) await this.jobs.watch(pending.jobId, target, update, signal);
                    return;
                }
                if (!pending.jobId && (pending.cancelRequested || (!retry && pending.request.priority === 'prefetch' && !this.autoMemos))) {
                    await this.enqueue(view, async () => { signal.throwIfAborted(); delete view.draft.pending; await this.store.save(view.draft); });
                    if (view.panel && pending.request.priority !== 'prefetch') vscode.window.setStatusBarMessage('작업을 취소했습니다.', 3000);
                    return;
                }
                let job = pending.jobId ? await this.jobs.job(pending.jobId, target) : await this.jobs.create(pending.request, target);
                if (signal.aborted && pending.cancelRequested && !pending.jobId) await this.jobs.cancel(job.id, target).catch(() => {});
                signal.throwIfAborted();
                await this.enqueue(view, async () => { signal.throwIfAborted(); pending.jobId = job.id; await this.store.save(view.draft); });
                signal.throwIfAborted();
                if (retry && ['failed', 'cancelled'].includes(job.status) && !pending.cancelRequested) job = await this.jobs.retry(job.id, target);
                if (pending.cancelRequested && ['queued', 'running', 'failed'].includes(job.status)) job = (await this.jobs.cancel(job.id, target))!;
                update(job);
                if (['queued', 'running'].includes(job.status)) {
                    const watch = () => this.jobs.watch(job.id, target, update, signal);
                    if (pending.request.priority === 'prefetch' || !view.panel) job = await watch();
                    else {
                        const title = pending.request.kind === 'prepare_blog' ? '구간과 풀이 설명을 준비하고 있어요…' : '글을 작성하고 있어요…';
                        job = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
                            const cancel = token.onCancellationRequested(() => {
                                void this.enqueue(view, async () => {
                                    if (!signal.aborted && view.watcher === controller && view.editable && view.draft.pending?.request.requestId === pending.request.requestId) {
                                        await this.cancelPending(view);
                                    }
                                }).catch(() => {});
                            });
                            try { return await watch(); } finally { cancel.dispose(); }
                        });
                    }
                }
                if (job.status === 'completed') {
                    if (!job.result || (pending.request.kind === 'prepare_blog' ? !job.result.plan : typeof job.result.markdown !== 'string')) throw new Error('AI 응답에 글이 없습니다. 다시 시도해 주세요.');
                    await this.enqueue(view, async () => {
                        signal.throwIfAborted();
                        const applied = view.draft.revision === pending.baseRevision;
                        const previousArticles = writingActivityContent(view.draft).articles;
                        if (pending.append && pending.history && job.result!.plan) {
                            const previous = { history: view.draft.history, fingerprint: view.draft.fingerprint };
                            if (appendMemoResult(view.draft, pending.history, job.result!.plan, job.result!.notices)) view.previousMemoHistory = previous;
                        } else {
                            mergeResult(view.draft, { ...job.result!,
                                ...(pending.request.kind === 'write_blog' && isServerTarget(target) ? { articleOrigin: { ...target, jobId: job.id } } : {}),
                                ...(pending.history ? { history: pending.history } : {}) }, pending.baseRevision);
                        }
                        if (pending.history && !view.draft.candidate) {
                            const index = pending.history.snapshots.length - 1;
                            view.draft.lastPreparation = { index, hash: pending.history.snapshots[index].hash, at: Date.now() };
                            view.draft.preparationKey = historyFingerprint(pending.history);
                        }
                        if (pending.request.kind === 'write_blog') registerGeneratedArticles(view.draft, previousArticles);
                        delete view.draft.pending;
                        await this.store.save(view.draft);
                        if (applied && pending.request.kind === 'write_blog' && !pending.cancelRequested) this.autoUpload(view);
                    });
                    view.partial = '';
                } else if (job.status === 'failed') {
                    throw new Error(job.error || '글쓰기에 실패했습니다. 다시 시도할 수 있습니다.');
                } else if (job.status === 'cancelled') {
                    if (pending.request.priority === 'prefetch' && job.errorCode === 'PREFETCH_DEFERRED') {
                        view.memoRetryAt = Date.now() + MEMO_COOLDOWN;
                    }
                    await this.enqueue(view, async () => { signal.throwIfAborted(); delete view.draft.pending; await this.store.save(view.draft); });
                    view.partial = '';
                    if (view.panel && pending.request.priority !== 'prefetch') vscode.window.setStatusBarMessage('작업을 취소했습니다.', 3000);
                }
            } catch (error) {
                if (error instanceof DraftConflict) await this.enqueue(view, () => this.refresh(view));
                else if (!signal.aborted && view.editable && pending.request.priority === 'prefetch') {
                    const deferred = error instanceof ServiceError && error.code === 'PREFETCH_DEFERRED';
                    const transient = error instanceof ServiceError && [402, 429, 503].includes(error.status);
                    view.memoRetryAt = deferred ? error.retryAt : transient ? Date.now() + MEMO_COOLDOWN : undefined;
                    if (!deferred && !transient) Logger.warn('자동 메모 준비를 마치지 못했습니다.', error);
                    await this.enqueue(view, async () => {
                        if (signal.aborted) return;
                        // Preserve the request ID after an ambiguous network failure so a retry
                        // can reconnect to the existing job without starting a duplicate.
                        if (error instanceof ServiceError && (error.status === 0 || error.status >= 500 && error.status !== 503)) {
                            view.memoRetryAt = Date.now() + MEMO_COOLDOWN;
                        } else {
                            delete view.draft.pending;
                            await this.store.save(view.draft);
                        }
                        view.error = '';
                    });
                } else if (!signal.aborted) this.notifyError(view, error instanceof Error ? error.message : String(error), 'retry');
            } finally {
                if (!this.closing) void this.connection.refreshUsage(true);
                if (view.watcher === controller) {
                    view.task = undefined;
                    if (signal.aborted && backendRequests.enabled && (view.editable || view.panel)) this.run(view);
                    this.render(view);
                    if (!this.closing && !view.panel && !view.draft.pending) {
                        await this.enqueue(view, async () => {
                            if (!view.panel && !view.draft.pending) await this.store.release(view.draft.filePath);
                        }).catch(() => {});
                    }
                }
            }
        });
        this.render(view);
    }
}
