import { GhostConnection } from '../ghost/GhostConnection';
import { GhostPublisher, GhostState, articleHash, PublishArticle } from '../ghost/GhostPublisher';
import { ArticleAssets, imageRefs, mapImages } from '../ghost/ArticleAssets';
import { documentFromMarkdown, documentHtml, documentMarkdown, validateDocument } from '../writing/ArticleDocument';
import { separateArticleTitle } from '../writing/ArticleContent';
import * as vscode from 'vscode';
import * as path from 'path';
import MarkdownIt = require('markdown-it');
import { articleHtml, taggedMarkdown } from '../writing/ArticleExport';
import { normalizeExportTags } from '../settings/ExportTags';
import { checkInputSize } from '../writing/InputLimits';
import { WRITING_MODES, WritingMode, WRITING_STYLES, WritingStyle, writingInstructions } from '../writing/WritingStyle';
import { isWritingModel, selectedWritingModel } from '../writing/WritingModels';
import { randomBytes, randomUUID } from 'crypto';
import { storageManager } from '../storage/StorageManager';
import { ServiceConnection, ServiceError } from '../writing/ServiceConnection';
import { JobRouter, JobTarget, isServerTarget } from '../writing/JobRouter';
import { DraftStore, DraftConflict } from '../writing/DraftStore';
import { registerGeneratedArticles, writingActivityContent, WritingActivityContent, WritingActivityStore, WritingActivitySummary } from '../writing/WritingActivity';
import { WindowSession } from '../storage/WindowSession';
import { ConnectionEnvironment } from '../writing/ConnectionSettings';
import {
    WritingDraft,
    mergeResult,
    newDraft,
    sourceFor,
    writingSourceFor,
    preparationSource,
    validatePlan,
    historyFingerprint,
    articleVersionKey,
    previousArticleVersions,
} from '../writing/model';
import template from './templates/blogPostMain.html';
import css from './templates/blogPostMain.css';
import script from './templates/blogPostMainScripts.webview.js';

interface View {
    panel?: vscode.WebviewPanel;
    draft: WritingDraft;
    queue: Promise<unknown>;
    task?: Promise<void>;
    error: string;
    status: string;
    progress: number;
    ready: boolean;
    partial?: string;
    watcher?: AbortController;
    announced?: string;
    editable: boolean;
    sync?: { dispose(): void };
    ownerCheck?: NodeJS.Timeout;
    ghost?: GhostState;
    activity?: WritingActivityContent;
    activityVersion?: number;
}
export class BlogPostManager {
    public static readonly viewType = 'psb.blogPost';
    private static views = new Map<string, View>();
    private static openings = new Map<string, Promise<void>>();
    private static store: DraftStore;
    private static activity: WritingActivityStore;
    private static ghost: GhostConnection;
    private static publisher: GhostPublisher;
    private static assets: ArticleAssets;
    private static exports = new Set<Promise<void>>();
    private static ghostUploads = new Map<string, Promise<void>>();
    private static jobs: JobRouter;
    private static connection: ServiceConnection;
    private static loads = new Map<string, Promise<View | undefined>>();
    private static closing = false;
    private static updates = new vscode.EventEmitter<string>();
    static readonly onDidChange = this.updates.event;
    static init(context: vscode.ExtensionContext, development: ConnectionEnvironment = {}) {
        this.assets = new ArticleAssets(path.join(context.globalStorageUri.fsPath, 'article-assets'));
        this.ghost = new GhostConnection(context);
        this.publisher = new GhostPublisher(path.join(context.globalStorageUri.fsPath, 'ghost-publications'), this.assets);
        context.subscriptions.push(context.secrets.onDidChange(event => { if (event.key === GhostConnection.key) for (const view of this.views.values()) void this.refreshGhost(view); }));
        this.store = new DraftStore(path.join(context.globalStorageUri.fsPath, 'writing'));
        this.activity = new WritingActivityStore(path.join(context.globalStorageUri.fsPath, 'writing-viewed.json'),
            file => this.store.read(file), (file, changed) => this.store.watch(file, changed), file => this.updates.fire(file));
        context.subscriptions.push(this.activity);
        this.connection = new ServiceConnection(context, development);
        this.jobs = new JobRouter(this.connection);
        context.subscriptions.push(
            vscode.commands.registerCommand('psb.connect', () => this.connect()),
            vscode.commands.registerCommand('psb.connectGhost', async () => { await this.ghost.configure(); }),
            vscode.commands.registerCommand('psb.sample', async () => this.openPage(context.extensionUri, await storageManager.installSampleHistory())),
            this.connection.changed.event(() => this.updates.fire('')),
            this.connection.changed,
            vscode.window.onDidChangeWindowState(() => {
                for (const view of this.views.values()) {
                    if (view.ready) void view.panel?.webview.postMessage({ type: 'writingVisibility', visible: this.writingIsVisible(view) });
                }
            }),
            vscode.workspace.onDidChangeConfiguration(event => {
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
                        await this.openPage(context.extensionUri, filePath, panel);
                    } catch {
                        panel.dispose();
                    }
                },
            }),
        );
    }
    static async flush() {
        this.closing = true;
        for (const view of this.views.values()) {
            view.sync?.dispose(); clearInterval(view.ownerCheck); view.watcher?.abort();
        }
        await Promise.all([...this.views.values()].map((view) => view.queue));
        await Promise.allSettled([...this.exports]);
        await this.publisher?.close();
        await this.store?.close();
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
                result[index] = { ...log, writingActivity: await this.writingActivity(log.filePath) };
            }
        }));
        return result;
    }
    static notices() { return this.connection.notices.current(); }
    static refreshNotices() { return this.connection.notices.refresh(); }
    static dismissNotice(id: string) { return this.connection.notices.dismiss(id); }
    static showUsage() { return this.connection.showUsage(); }
    static preparationStatus(filePath: string) {
        const view = this.views.get(filePath);
        return view?.error ? '글쓰기 준비를 다시 시도할 수 있어요.' : view?.draft.pending ? 'AI가 글쓰기 내용을 준비하고 있어요…' : view?.draft.plan ? '글쓰기 준비가 끝났어요.' : '글쓰기에서 AI가 풀이를 정리해 드려요.';
    }
    private static async loadView(filePath: string): Promise<View | undefined> {
        if (this.views.has(filePath)) return this.views.get(filePath);
        if (this.loads.has(filePath)) return this.loads.get(filePath);
        const loading = (async () => {
            const saved = await this.store.read(filePath);
            const history = saved?.history || await storageManager.getFileHistory(filePath);
            if (!history?.snapshots.length) return undefined;
            const draft = await this.store.open(saved || newDraft(history));
            const view: View = { draft, editable: this.store.owns(draft), queue: Promise.resolve(), error: '', status: '', progress: 0, ready: false };
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
    static async prepareOnReview(filePath: string) {
        if (!vscode.workspace.getConfiguration('psb').get('prepareOnReview', true)) return;
        try {
            const target = await this.jobs.target(false); // Reviewing never opens a login prompt.
            const view = await this.loadView(filePath);
            if (!view) return;
            await this.enqueue(view, async () => {
                await this.refresh(view, true);
                if (!view.editable) return;
                if (view.draft.pending) { this.run(view); return; }
                const history = await storageManager.getFileHistory(filePath);
                if (!history?.snapshots.length) return;
                // Preparation does not depend on the selected model, so only the history matters.
                const fingerprint = historyFingerprint(history);
                if (view.draft.preparationKey === fingerprint || (view.draft.plan && view.draft.fingerprint === fingerprint)) return;
                await this.start(view, 'prepare_blog', target, true);
            });
        } catch { /* Optional preparation must not interrupt history viewing. */ }
    }
    public static async openPage(
        extensionUri: vscode.Uri,
        filePath: string,
        restoredPanel?: vscode.WebviewPanel,
    ) {
        const opening = this.openings.get(filePath);
        if (opening) {
            await opening;
            this.views.get(filePath)?.panel?.reveal();
            return;
        }
        const operation = this.openPageInternal(extensionUri, filePath, restoredPanel).finally(() =>
            this.openings.delete(filePath),
        );
        this.openings.set(filePath, operation);
        await operation;
    }
    private static async openPageInternal(
        extensionUri: vscode.Uri,
        filePath: string,
        restoredPanel?: vscode.WebviewPanel,
    ) {
        const view = await this.loadView(filePath);
        if (view?.panel && !restoredPanel) {
            view.panel.reveal();
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
        current.ready = false;
        panel.onDidChangeViewState(() => {
            if (current.ready) void panel.webview.postMessage({ type: 'writingVisibility', visible: this.writingIsVisible(current) });
        });
        panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(this.assets.directory)] };
        panel.onDidDispose(() => {
            if (current.panel === panel) {
                current.panel = undefined;
                current.ready = false;
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
            void this.enqueue(current, async () => {
                try {
                    await this.handle(current, message);
                    void panel.webview.postMessage({ type: 'ack', id: message?.id });
                } catch (error) {
                    if (error instanceof DraftConflict) await this.refresh(current);
                    current.error = error instanceof Error ? error.message : String(error);
                    void panel.webview.postMessage({
                        type: 'saveError',
                        id: message?.id,
                        message: current.error,
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
            .replace('{{script}}', () => `<script nonce="${nonce}">${script}</script>`);
    }
    private static enqueue(view: View, action: () => Promise<void>) {
        const next = view.queue.then(action);
        view.queue = next.catch((error) => {
            view.error = error instanceof Error ? error.message : String(error);
            this.render(view);
        });
        return next;
    }
    private static async refresh(view: View, claim = false) {
        if (this.closing) return;
        let latest = await this.store.read(view.draft.filePath);
        if (!latest) return;
        if ((claim || view.panel) && !this.store.owns(latest) && !await WindowSession.alive(latest.editor?.owner)) latest = await this.store.open(latest);
        if (latest.storageVersion === view.draft.storageVersion && latest.editor?.token === view.draft.editor?.token) return;
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
        return !!view.panel?.visible && !!view.panel.active && vscode.window.state.focused;
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
        void view.panel?.webview.postMessage({
            type: 'model',
            filePath: draft.filePath,
            fileName: path.basename(draft.filePath),
            activity: view.activity.visible,
            writingVisible: this.writingIsVisible(view),
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
            revision: draft.revision,
            editable: view.editable,
            editToken: draft.editor?.token,
            count: draft.history.snapshots.length,
            times: draft.history.snapshots.map((s) => s.timestamp),
            pending: !!draft.pending,
            pendingId: draft.pending?.request.requestId,
            pendingKind: draft.pending?.request.kind,
            running: !!view.task,
            progress: view.progress,
            status: view.status,
            error: view.error,
            candidate: !!draft.candidate,
            versions: previousArticleVersions(draft).map((v) => ({ id: articleVersionKey(v), at: v.at, title: v.title })),
            streamHtml: view.partial ? new MarkdownIt({ html: false }).render(view.partial) : '',
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
    private static async refreshGhost(view: View) {
        try { view.ghost = await this.publisher.state(await this.ghost.get(), view.draft.filePath); }
        catch { view.ghost = { connected: false, error: 'Ghost 연결 정보를 확인해 주세요.' }; }
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
        const filePath = view.draft.filePath, previous = this.ghostUploads.get(filePath);
        if (!automatic && previous) throw new Error('Ghost에 저장 중입니다.');
        const operation = (async () => {
            if (previous) await previous;
            // A setting change can cancel an upload that has not started yet.
            if (automatic && this.automaticGhostMode() !== (publish ? 'publish' : 'draft')) return;
            view.ghost = { ...(view.ghost || { connected: false }), busy: true }; this.sendGhost(view);
            try {
                const settings = await this.ghost.get() || (!automatic ? await this.ghost.configure() : undefined);
                if (!settings) {
                    if (automatic) throw new Error('설정의 Ghost 연결 / 변경에서 먼저 연결해 주세요. 글은 로컬에 저장되어 있습니다.');
                    await this.refreshGhost(view); return;
                }
                if (!automatic && publish && await vscode.window.showWarningMessage(`“${article.title}”을 ${new URL(settings.url).host}에 공개 게시할까요?`, { modal: true }, '공개 게시') !== '공개 게시') { await this.refreshGhost(view); return; }
                view.ghost = { ...await this.publisher.state(settings, filePath), busy: true }; this.sendGhost(view);
                if (automatic && this.automaticGhostMode() !== (publish ? 'publish' : 'draft')) { await this.refreshGhost(view); return; }
                view.ghost = await this.publisher.publish(settings, filePath, article, publish, { draftOnly: automatic && !publish });
                if (automatic) {
                    view.status = publish ? '글을 완성하고 Ghost에 공개 게시했습니다.' : '글을 완성하고 Ghost에 초안으로 저장했습니다.';
                    this.render(view);
                }
            } catch (error) {
                await this.refreshGhost(view);
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
                if (draft.pending || view.task) throw new Error('진행 중인 요청을 마친 뒤 모델을 변경해 주세요.');
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
        await this.store.save(draft);
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
        const reading = ['ready', 'takeover', 'viewedWriting', 'diff', 'preview', 'previewVersion', 'export', 'copy', 'openLink', 'connect', 'rechargeCredits', 'ghostConnect', 'ghostOpen'].includes(message.type);
        if (!reading && (!view.editable || message.editToken !== view.draft.editor?.token)) throw new DraftConflict();
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
                else if (!view.draft.plan) await this.start(view, 'prepare_blog');
                break;
            }
            case 'ready':
                view.ready = true;
                void this.connection.refreshUsage();
                await this.refreshGhost(view);
                this.render(view);
                if (view.draft.pending) this.run(view);
                else if (!view.draft.plan && view.editable) await this.start(view, 'prepare_blog');
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
                if (view.draft.pending) {
                    view.draft.pending.cancelRequested = true;
                    await this.store.save(view.draft);
                    if (view.draft.pending.jobId && isServerTarget(view.draft.pending.target)) await this.jobs.cancel(view.draft.pending.jobId, view.draft.pending.target);
                    this.run(view);
                }
                break;
            case 'discardPending':
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
                }
                break;
            case 'discardCandidate':
                delete view.draft.candidate;
                await this.store.save(view.draft);
                break;
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
                const html = documentHtml(view.draft.document || documentFromMarkdown(view.draft.markdown), this.imageSources(view, view.draft));
                void view.panel?.webview.postMessage({ type: 'preview', html });
                break;
            }
            case 'previewVersion': {
                const version = this.version(view.draft, message.versionId);
                void view.panel?.webview.postMessage({
                    type: 'versionPreview', versionId: message.versionId, title: version.title,
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
                    view.status = `${html ? 'HTML' : 'Markdown'} 파일로 저장했습니다.`;
                }
                break;
            }
            case 'copy':
                if (!message.versionId && view.editable && message.editToken === view.draft.editor?.token) await this.edit(view, message.fields);
                await vscode.env.clipboard.writeText(this.markdown(message.versionId ? this.version(view.draft, message.versionId) : view.draft));
                view.status = '글을 복사했습니다.';
                break;
            case 'restore': {
                const version = this.version(view.draft, message.versionId);
                await this.edit(view, message.fields);
                mergeResult(
                    view.draft,
                    { title: version.title, markdown: version.markdown, document: version.document },
                    view.draft.revision,
                );
                await this.store.save(view.draft);
                view.status = '선택한 버전을 적용했습니다.';
                break;
            }
            case 'openLink': {
                const url = new URL(String(message.url));
                if (['http:', 'https:', 'mailto:'].includes(url.protocol)) {
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
            case 'ghostConnect':
                await this.ghost.configure(); await this.refreshGhost(view); break;
            case 'ghostOpen': {
                await this.refreshGhost(view);
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
            case 'rechargeCredits':
                await this.connection.showCreditRecharge();
                break;
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
    private static async start(view: View, kind: 'prepare_blog' | 'write_blog', target?: JobTarget, prefetch = false) {
        if (!view.editable) return;
        if (view.draft.pending || view.task) return;
        const draft = view.draft;
        const history =
            kind === 'prepare_blog'
                ? (await storageManager.getFileHistory(draft.filePath)) || draft.history
                : draft.history;
        const plan = draft.plan
            ? {
                  ...draft.plan,
                  title: draft.plan.title.trim() || path.basename(draft.filePath) + ' 풀이 기록',
              }
            : undefined;
        if (kind === 'write_blog' && !plan) {
            throw new Error('AI가 풀이 흐름을 준비한 뒤 글을 만들 수 있습니다.');
        }
        if (plan && kind === 'write_blog') {
            plan.steps = plan.steps
                .filter((step) => step.end >= plan.start && step.start <= plan.end)
                .map((step) => ({
                    ...step,
                    start: Math.max(step.start, plan.start),
                    end: Math.min(step.end, plan.end),
                }));
        }
        const source =
            kind === 'prepare_blog'
                ? preparationSource(history)
                : writingSourceFor(history, plan!.start, plan!.end, plan!.steps.flatMap((step) => [step.start, step.end]));
        checkInputSize({ source });
        const instructions = writingInstructions(draft);
        target ||= await this.jobs.target(!prefetch);
        if (kind === 'prepare_blog') draft.preparationKey = historyFingerprint(history);
        draft.pending = {
            target,
            request: {
                kind,
                // The server always prepares memos with its own model; the choice applies to the article only.
                ...(kind === 'write_blog' ? { model: selectedWritingModel(draft.writingModel) } : {}),
                priority: prefetch ? 'prefetch' : 'interactive',
                requestId: randomUUID(),
                source,
                ...(kind === 'write_blog' ? { plan: structuredClone(plan!) } : {}),
                instructions,
            },
            baseRevision: kind === 'prepare_blog' && plan ? -1 : draft.revision,
            ...(kind === 'prepare_blog' ? { history: structuredClone(history) } : {}),
        };
        await this.store.save(draft);
        this.run(view);
    }
    private static run(view: View, retry = false) {
        if (this.closing || view.task || !view.draft.pending) return;
        const pending = view.draft.pending;
        view.error = '';
        view.partial = '';
        view.watcher = new AbortController();
        const controller = view.watcher, signal = controller.signal;
        view.status = pending.request.kind === 'prepare_blog' ? '구간과 풀이 설명을 준비하고 있어요…' : '글을 작성하고 있어요…';
        view.task = Promise.resolve().then(async () => {
            try {
                if (pending.apiUrl || !isServerTarget(pending.target)) {
                    if (!view.editable) return;
                    if (pending.cancelRequested) {
                        await this.enqueue(view, async () => { signal.throwIfAborted(); delete view.draft.pending; await this.store.save(view.draft); });
                        view.status = '작업을 취소했습니다.';
                        return;
                    }
                    if (!retry) throw new Error('이전 실행 방식의 작업입니다. 다시 시도하면 현재 서비스로 새 요청을 보냅니다.');
                    const target = await this.jobs.target();
                    delete pending.apiUrl;
                    delete pending.jobId;
                    pending.request.requestId = randomUUID();
                    pending.target = target;
                    await this.enqueue(view, async () => { signal.throwIfAborted(); await this.store.save(view.draft); });
                }
                const target = pending.target;
                if (!view.editable) {
                    if (pending.jobId) {
                        await this.jobs.watch(pending.jobId, target, job => {
                            if (!signal.aborted) { view.progress = job.progress; view.partial = job.partial; this.render(view); }
                        }, signal);
                    }
                    return;
                }
                if (pending.cancelRequested && !pending.jobId) {
                    await this.enqueue(view, async () => { signal.throwIfAborted(); delete view.draft.pending; await this.store.save(view.draft); });
                    view.status = '작업을 취소했습니다.';
                    return;
                }
                let job = pending.jobId ? await this.jobs.job(pending.jobId, target) : await this.jobs.create(pending.request, target);
                signal.throwIfAborted();
                await this.enqueue(view, async () => { signal.throwIfAborted(); pending.jobId = job.id; await this.store.save(view.draft); });
                signal.throwIfAborted();
                if (retry && ['failed', 'cancelled'].includes(job.status) && !pending.cancelRequested) job = await this.jobs.retry(job.id, target);
                if (pending.cancelRequested && ['queued', 'running', 'failed'].includes(job.status)) job = (await this.jobs.cancel(job.id, target))!;
                const update = (value: typeof job) => { if (!signal.aborted) { view.progress = value.progress; view.partial = value.partial; this.render(view); } };
                update(job);
                if (['queued', 'running'].includes(job.status)) job = await this.jobs.watch(job.id, target, update, signal);
                if (job.status === 'completed') {
                    if (!job.result || (pending.request.kind === 'prepare_blog' ? !job.result.plan : typeof job.result.markdown !== 'string')) throw new Error('AI 응답에 글이 없습니다. 다시 시도해 주세요.');
                    await this.enqueue(view, async () => {
                        signal.throwIfAborted();
                        const applied = view.draft.revision === pending.baseRevision;
                        const previousArticles = writingActivityContent(view.draft).articles;
                        mergeResult(view.draft, { ...job.result!, ...(pending.history ? { history: pending.history } : {}) }, pending.baseRevision);
                        if (pending.request.kind === 'write_blog') registerGeneratedArticles(view.draft, previousArticles);
                        delete view.draft.pending;
                        await this.store.save(view.draft);
                        if (applied && pending.request.kind === 'write_blog' && !pending.cancelRequested) this.autoUpload(view);
                    });
                    view.partial = '';
                    view.status = view.draft.candidate ? '수정한 내용을 보존했습니다. 새 결과를 적용할 수 있어요.' : pending.request.kind === 'prepare_blog' ? '준비됐어요. 그대로 글을 쓰거나 설명을 고쳐보세요.' : '글을 완성했습니다.';
                    if (pending.history && pending.request.source.changes.length < pending.history.snapshots.length) view.status += ` 최근 ${pending.request.source.changes.length}개 변경을 분석했습니다.`;
                } else if (job.status === 'failed') {
                    throw new Error(job.error || '글쓰기에 실패했습니다. 다시 시도할 수 있습니다.');
                } else if (job.status === 'cancelled') {
                    await this.enqueue(view, async () => { signal.throwIfAborted(); delete view.draft.pending; await this.store.save(view.draft); });
                    view.partial = '';
                    view.status = '작업을 취소했습니다.';
                }
            } catch (error) {
                if (error instanceof DraftConflict) await this.enqueue(view, () => this.refresh(view));
                else if (!signal.aborted) view.error = error instanceof Error ? error.message : String(error);
            } finally {
                if (!this.closing) void this.connection.refreshUsage(true);
                if (view.watcher === controller) {
                    view.task = undefined;
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
