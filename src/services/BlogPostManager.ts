import * as vscode from 'vscode';
import * as path from 'path';
import MarkdownIt = require('markdown-it');
import { randomBytes, randomUUID } from 'crypto';
import { storageManager } from '../storage/StorageManager';
import { LocalJobs } from '../writing/LocalJobs';
import { Writer } from '../writing/Writer';
import { AiConfiguration } from '../writing/AiSettings';
import { ServiceConnection, ServiceError } from '../writing/ServiceConnection';
import { JobRouter, JobTarget } from '../writing/JobRouter';
import { DraftStore } from '../writing/DraftStore';
import {
    WritingDraft,
    mergeResult,
    newDraft,
    sourceFor,
    preparationSource,
    validatePlan,
    historyFingerprint,
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
}
export class BlogPostManager {
    public static readonly viewType = 'psb.blogPost';
    private static views = new Map<string, View>();
    private static openings = new Map<string, Promise<void>>();
    private static store: DraftStore;
    private static jobs: JobRouter;
    private static ai: AiConfiguration;
    private static connection: ServiceConnection;
    private static loads = new Map<string, Promise<View | undefined>>();
    private static updates = new vscode.EventEmitter<string>();
    static readonly onDidChange = this.updates.event;
    static init(context: vscode.ExtensionContext) {
        this.store = new DraftStore(path.join(context.globalStorageUri.fsPath, 'writing'));
        this.ai = new AiConfiguration(context);
        const writer = new Writer({ settings: () => this.ai.get() });
        this.connection = new ServiceConnection(context);
        this.jobs = new JobRouter(new LocalJobs(path.join(context.globalStorageUri.fsPath, 'writing-jobs'), (request, signal) => writer.run(request, signal)), this.connection);
        context.subscriptions.push(
            vscode.commands.registerCommand('psb.connect', () => this.connect()),
            vscode.commands.registerCommand('psb.sample', async () => this.openPage(context.extensionUri, await storageManager.installSampleHistory())),
            this.connection.changed.event(() => this.updates.fire('')),
            this.connection.changed,
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
        for (const view of this.views.values()) view.watcher?.abort();
        await Promise.all([...this.views.values()].map((view) => view.queue));
        await this.store?.flush();
        await this.jobs?.close();
    }
    static async connect() {
        if (this.jobs.direct) await this.ai.configure();
        else await this.connection.configure();
    }
    static async accountLabel() { return this.jobs.direct ? '직접 호출 · AI 설정' : (await this.connection.account())?.email || '로그인'; }
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
            const view: View = { draft: saved || newDraft(history), queue: Promise.resolve(), error: '', status: '', progress: 0, ready: false };
            this.views.set(filePath, view);
            return view;
        })().finally(() => this.loads.delete(filePath));
        this.loads.set(filePath, loading);
        return loading;
    }
    static async prepareOnReview(filePath: string) {
        if (!vscode.workspace.getConfiguration('psb').get('prepareOnReview', true)) return;
        try {
            if (this.jobs.direct && !await this.ai.available()) return;
            const target = await this.jobs.target(false); // Reviewing never opens a login prompt.
            const view = await this.loadView(filePath);
            if (!view) return;
            await this.enqueue(view, async () => {
                if (view.draft.pending) { this.run(view); return; }
                const history = await storageManager.getFileHistory(filePath);
                if (!history?.snapshots.length) return;
                const key = historyFingerprint(history);
                if (view.draft.preparationKey === key || (view.draft.plan && view.draft.fingerprint === key)) return;
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
        panel.webview.options = { enableScripts: true, localResourceRoots: [] };
        panel.onDidDispose(() => {
            if (current.panel === panel) {
                current.panel = undefined;
                current.ready = false;
            }
        });
        panel.webview.onDidReceiveMessage((message) => {
            void this.enqueue(current, async () => {
                try {
                    await this.handle(current, message);
                    void panel.webview.postMessage({ type: 'ack', id: message?.id });
                } catch (error) {
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
                `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:;`,
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
    private static render(view: View) {
        const announcement = `${!!view.draft.pending}:${!!view.draft.plan}:${view.error}`;
        if (view.announced !== announcement) { view.announced = announcement; this.updates.fire(view.draft.filePath); }
        if (!view.ready) return;
        const { draft } = view;
        void view.panel?.webview.postMessage({
            type: 'model',
            filePath: draft.filePath,
            fileName: path.basename(draft.filePath),
            plan: draft.plan,
            instructions: draft.instructions,
            title: draft.title,
            markdown: draft.markdown,
            revision: draft.revision,
            count: draft.history.snapshots.length,
            times: draft.history.snapshots.map((s) => s.timestamp),
            pending: !!draft.pending,
            running: !!view.task,
            progress: view.progress,
            status: view.status,
            error: view.error,
            candidate: !!draft.candidate,
            versions: draft.articleVersions.map((v) => ({ at: v.at, title: v.title })),
            streamHtml: view.partial ? new MarkdownIt({ html: false }).render(view.partial) : '',
        });
    }
    private static async edit(view: View, fields: unknown) {
        if (!fields || typeof fields !== 'object') return;
        const value = fields as Record<string, unknown>,
            draft = view.draft;
        const before = JSON.stringify([
            draft.plan,
            draft.instructions,
            draft.title,
            draft.markdown,
        ]);
        const patch: Record<string, unknown> = {};
        for (const [key, limit] of [
            ['instructions', 12000],
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
        if (value.plan !== undefined) {
            patch.plan = validatePlan(value.plan, draft.history.snapshots.length, true);
        }
        Object.assign(draft, patch);
        if (
            before !== JSON.stringify([draft.plan, draft.instructions, draft.title, draft.markdown])
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
            JSON.stringify(message).length > 400000
        ) {
            throw new Error('화면 요청을 확인할 수 없습니다.');
        }
        switch (message.type) {
            case 'ready':
                view.ready = true;
                this.render(view);
                if (view.draft.pending) this.run(view);
                else if (!view.draft.plan) await this.start(view, 'prepare_blog');
                break;
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
                    if (view.draft.pending.jobId) await this.jobs.cancel(view.draft.pending.jobId, view.draft.pending.target || { kind: 'direct' });
                    this.run(view);
                }
                break;
            case 'discardPending':
                if (view.task) throw new Error('작업을 취소한 뒤 다시 시도해 주세요.');
                if (view.draft.pending?.jobId && !view.draft.pending.apiUrl) {
                    try { await this.jobs.cancel(view.draft.pending.jobId, view.draft.pending.target || { kind: 'direct' }); }
                    catch (error) { if (!(error instanceof ServiceError && error.status === 404)) throw error; }
                }
                delete view.draft.pending;
                view.error = '';
                await this.store.save(view.draft);
                break;
            case 'applyCandidate':
                await this.edit(view, message.fields);
                if (view.draft.candidate) {
                    mergeResult(view.draft, view.draft.candidate, view.draft.revision);
                    delete view.draft.candidate;
                    await this.store.save(view.draft);
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
                await this.edit(view, message.fields);
                const html = new MarkdownIt({ html: false }).render(view.draft.markdown);
                void view.panel?.webview.postMessage({ type: 'preview', html });
                break;
            }
            case 'export': {
                await this.edit(view, message.fields);
                const uri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(
                        path.join(
                            path.dirname(view.draft.filePath),
                            path.basename(view.draft.filePath, path.extname(view.draft.filePath)) +
                                '.md',
                        ),
                    ),
                    filters: { Markdown: ['md'] },
                });
                if (uri) {
                    await vscode.workspace.fs.writeFile(
                        uri,
                        Buffer.from(this.markdown(view.draft)),
                    );
                    view.status = 'Markdown 파일로 저장했습니다.';
                }
                break;
            }
            case 'copy':
                await this.edit(view, message.fields);
                await vscode.env.clipboard.writeText(this.markdown(view.draft));
                view.status = '글을 복사했습니다.';
                break;
            case 'restore': {
                await this.edit(view, message.fields);
                const version = view.draft.articleVersions[Number(message.index)];
                if (!version) throw new Error('이전 글을 찾을 수 없습니다.');
                mergeResult(
                    view.draft,
                    { title: version.title, markdown: version.markdown },
                    view.draft.revision,
                );
                await this.store.save(view.draft);
                break;
            }
            case 'openLink': {
                const url = new URL(String(message.url));
                if (['http:', 'https:'].includes(url.protocol)) {
                    await vscode.env.openExternal(vscode.Uri.parse(url.href));
                }
                break;
            }
            case 'connect':
                await this.connect();
                break;
            default:
                throw new Error('지원하지 않는 화면 요청입니다.');
        }
    }
    private static markdown(draft: WritingDraft) {
        return `# ${draft.title || draft.plan?.title || '풀이 기록'}\n\n${draft.markdown}\n`;
    }
    private static async start(view: View, kind: 'prepare_blog' | 'write_blog', target?: JobTarget, prefetch = false) {
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
                : sourceFor(history, plan!.start, plan!.end);
        if (JSON.stringify(source).length > 480000) {
            throw new Error('분석할 기록이 너무 큽니다. 기록 범위를 줄여 주세요.');
        }
        target ||= await this.jobs.target(!prefetch);
        if (kind === 'prepare_blog') draft.preparationKey = historyFingerprint(history);
        draft.pending = {
            target,
            request: {
                kind,
                priority: prefetch ? 'prefetch' : 'interactive',
                requestId: randomUUID(),
                source,
                ...(kind === 'write_blog' ? { plan: structuredClone(plan!) } : {}),
                instructions: draft.instructions,
            },
            baseRevision: kind === 'prepare_blog' && plan ? -1 : draft.revision,
            ...(kind === 'prepare_blog' ? { history: structuredClone(history) } : {}),
        };
        await this.store.save(draft);
        this.run(view);
    }
    private static run(view: View, retry = false) {
        if (view.task || !view.draft.pending) return;
        const pending = view.draft.pending;
        view.error = '';
        view.partial = '';
        view.watcher = new AbortController();
        const signal = view.watcher.signal;
        view.status = pending.request.kind === 'prepare_blog' ? '구간과 풀이 설명을 준비하고 있어요…' : '글을 작성하고 있어요…';
        view.task = (async () => {
            try {
                if (pending.apiUrl) {
                    if (!retry && !pending.cancelRequested) throw new Error('이전 버전의 작업입니다. 다시 시도하면 현재 서비스로 새 요청을 보냅니다.');
                    delete pending.apiUrl;
                    delete pending.jobId;
                    pending.target = await this.jobs.target();
                }
                const target = pending.target || { kind: 'direct' as const };
                if (pending.cancelRequested && !pending.jobId) {
                    await this.enqueue(view, async () => { delete view.draft.pending; await this.store.save(view.draft); });
                    view.status = '작업을 취소했습니다.';
                    return;
                }
                let job = pending.jobId ? await this.jobs.job(pending.jobId, target) : await this.jobs.create(pending.request, target);
                await this.enqueue(view, async () => { pending.jobId = job.id; await this.store.save(view.draft); });
                if (retry && ['failed', 'cancelled'].includes(job.status) && !pending.cancelRequested) job = await this.jobs.retry(job.id, target);
                if (pending.cancelRequested && ['queued', 'running', 'failed'].includes(job.status)) job = (await this.jobs.cancel(job.id, target))!;
                const update = (value: typeof job) => { view.progress = value.progress; view.partial = value.partial; this.render(view); };
                update(job);
                if (['queued', 'running'].includes(job.status)) job = await this.jobs.watch(job.id, target, update, signal);
                if (job.status === 'completed') {
                    if (!job.result || (pending.request.kind === 'prepare_blog' ? !job.result.plan : typeof job.result.markdown !== 'string')) throw new Error('AI 응답에 글이 없습니다. 다시 시도해 주세요.');
                    await this.enqueue(view, async () => {
                        mergeResult(view.draft, { ...job.result!, ...(pending.history ? { history: pending.history } : {}) }, pending.baseRevision);
                        delete view.draft.pending;
                        await this.store.save(view.draft);
                    });
                    view.partial = '';
                    view.status = view.draft.candidate ? '수정한 내용을 보존했습니다. 새 결과를 적용할 수 있어요.' : pending.request.kind === 'prepare_blog' ? '준비됐어요. 그대로 글을 쓰거나 설명을 고쳐보세요.' : '글을 완성했습니다.';
                    if (pending.history && pending.request.source.changes.length < pending.history.snapshots.length) view.status += ` 최근 ${pending.request.source.changes.length}개 변경을 분석했습니다.`;
                } else if (job.status === 'failed') {
                    throw new Error(job.error || '글쓰기에 실패했습니다. 다시 시도할 수 있습니다.');
                } else if (job.status === 'cancelled') {
                    await this.enqueue(view, async () => { delete view.draft.pending; await this.store.save(view.draft); });
                    view.partial = '';
                    view.status = '작업을 취소했습니다.';
                }
            } catch (error) {
                if (!signal.aborted) view.error = error instanceof Error ? error.message : String(error);
            } finally {
                view.task = undefined;
                this.render(view);
            }
        })();
        this.render(view);
    }
}
