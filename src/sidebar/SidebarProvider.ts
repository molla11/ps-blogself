import * as vscode from 'vscode';
import { configManager } from '../config';
import { storageManager } from '../storage/StorageManager';
import { getSidebarHtml } from './getSidebarHtml';
import { HistoryManager } from '../services/HistoryManager';
import { BlogPostManager } from '../services/BlogPostManager';
import { RecentLogsPager } from './RecentLogsPager';
import type { CodeDiscovery, ListedFile } from './CodeDiscovery';

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'psb.sidebar';

    private _view?: vscode.WebviewView;
    private _stateRevision = 0;
    private _activityRevision = 0;
    private _recentLogs = this.createPager();

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _onSelectRootFolder: () => void,
        private readonly _onClearRootFolder: () => void,
        private readonly _onUseWorkspaceRoot: (directory: string) => void,
        private readonly _onToggleRecording: () => void,
        private readonly _onToggleLanguage: (lang: string) => void,
        private readonly codeFiles: CodeDiscovery,
    ) {}

    private createPager() {
        return new RecentLogsPager(async () => this.codeFiles.withHistory(await storageManager.getRecentFiles()));
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        const recentLogs = this._recentLogs = this.createPager();

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = getSidebarHtml(webviewView.webview, this._extensionUri, !!configManager.contest);

        const sendContestMode = () => webviewView.webview.postMessage({ type: 'contestMode', contest: configManager.contest });

        webviewView.webview.onDidReceiveMessage(async (data) => {
            try {
                if (!data || typeof data !== 'object') return;
                switch (data.type) {
                    case 'setContestMode': {
                        if (typeof data.enabled === 'boolean') await configManager.setContestMode(data.enabled);
                        break;
                    }
                    case 'setContestOption': {
                        if (typeof data.enabled === 'boolean' && ['recording', 'backend', 'writing'].includes(data.option)) {
                            await configManager.setContestOption(data.option, data.enabled);
                        }
                        break;
                    }
                    case 'selectRootFolder': {
                        await this._onSelectRootFolder();
                        break;
                    }
                    case 'clearRootFolder': {
                        await this._onClearRootFolder();
                        break;
                    }
                    case 'useWorkspaceRoot': {
                        if (typeof data.path === 'string' && data.path) await this._onUseWorkspaceRoot(data.path);
                        break;
                    }
                    case 'toggleRecording': {
                        await this._onToggleRecording();
                        break;
                    }
                    case 'toggleLanguage': {
                        await this._onToggleLanguage(data.value);
                        break;
                    }
                    case 'getInitialData': {
                        BlogPostManager.setSidebarVisible(webviewView.visible);
                        await sendContestMode();
                        this.codeFiles.start();
                        await this.updateState();
                        void BlogPostManager.refreshUsage();
                        void BlogPostManager.refreshNotices();
                        break;
                    }
                    case 'searchLogs':
                    case 'loadMoreLogs': {
                        if (!Number.isSafeInteger(data.requestId) || !Number.isSafeInteger(data.searchId)) break;
                        const searching = data.type === 'searchLogs';
                        if (searching) {
                            if (typeof data.query !== 'string' || data.searchId < recentLogs.searchId) break;
                            recentLogs.setSearch(data.query, data.searchId);
                        } else if (data.searchId !== recentLogs.searchId || !Number.isSafeInteger(data.count) || data.count < 0) break;
                        try {
                            const page = await recentLogs.load(searching ? undefined : data.count);
                            const enrichedLogs = await this.writingLogs(page.recentLogs);
                            await webviewView.webview.postMessage({
                                type: 'recentLogsPage', requestId: data.requestId,
                                discovering: this.codeFiles.searching, discoveryFailed: this.codeFiles.failed,
                                ...page, recentLogs: enrichedLogs,
                            });
                        } catch {
                            await webviewView.webview.postMessage({ type: 'recentLogsPage', requestId: data.requestId, recentLogsSearchId: data.searchId, error: '기록을 불러오지 못했습니다.' });
                        }
                        break;
                    }
                    case 'openFile': {
                        const document = await vscode.workspace.openTextDocument(data.path);
                        await vscode.window.showTextDocument(document, { preview: false });
                        // Editor activation may reveal another extension's sidebar.
                        // Keep this navigation's originating view without taking editor focus.
                        webviewView.show(true);
                        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                        break;
                    }
                    case 'viewHistory': {
                        const discovered = this.codeFiles.files.find(file => file.filePath === data.path);
                        await HistoryManager.openHistory(this._extensionUri, data.path, discovered?.language);
                        break;
                    }
                    case 'manageLogs': {
                        const allLogs = await storageManager.getAllLogs();
                        this._view?.webview.postMessage({
                            type: 'showFullLogs',
                            logs: await this.writingLogs(allLogs),
                        });
                        break;
                    }
                    case 'connectServer': {
                        await BlogPostManager.connect();
                        break;
                    }
                    case 'showUsage': {
                        await BlogPostManager.showUsage();
                        break;
                    }
                    case 'dismissNotice': {
                        if (typeof data.id === 'string' && /^[a-f0-9-]{36}$/i.test(data.id)) await BlogPostManager.dismissNotice(data.id);
                        break;
                    }
                    case 'sample':
                        await vscode.commands.executeCommand('psb.sample');
                        break;
                    case 'generateBlog':
                    case 'selectLogForBlog': {
                        const discovered = this.codeFiles.files.find(file => file.filePath === data.path);
                        if (typeof data.path === 'string') await BlogPostManager.openPage(this._extensionUri, data.path, { language: discovered?.language });
                        break;
                    }
                    case 'writerAction': {
                        BlogPostManager.sidebarAction(data.filePath, data.action, data.value);
                        break;
                    }
                }
            } catch (error) {
                if (data?.type === 'setContestMode' || data?.type === 'setContestOption') await sendContestMode();
                vscode.window.showErrorMessage(
                    error instanceof Error ? error.message : String(error),
                );
            }
        });

        const discovery = this.codeFiles.onDidChange(async () => {
            if (configManager.contest) return;
            // A directory scan can insert thousands of newer files ahead of the visible page.
            const page = await recentLogs.load(undefined, false);
            const rows = await this.writingLogs(page.recentLogs);
            if (this._view === webviewView) {
                await webviewView.webview.postMessage({
                    type: 'recentLogsPage', activeFile: vscode.window.activeTextEditor?.document.uri.fsPath,
                    discovering: this.codeFiles.searching, discoveryFailed: this.codeFiles.failed, ...page, recentLogs: rows,
                });
            }
        });
        const controls = BlogPostManager.onDidChangeControls(() => {
            if (this._view === webviewView && webviewView.visible) {
                void webviewView.webview.postMessage({ type: 'sidebarWriter', writer: BlogPostManager.sidebarWriter });
            }
        });
        webviewView.onDidDispose(() => {
            controls.dispose();
            discovery.dispose();
            if (this._view === webviewView) {
                this._view = undefined;
                BlogPostManager.setSidebarVisible(false);
            }
        });

        // Listen for storage updates to refresh UI
        const disposable = storageManager.onDidUpdateIndex(() => {
            this.updateState();
        });
        webviewView.onDidDispose(() => disposable.dispose());
        const accountUpdate = BlogPostManager.onDidChange(file => {
            if (!file) void this.updateState();
            else if (!configManager.contest) void this.updateWritingActivity(file);
        });
        webviewView.onDidDispose(() => accountUpdate.dispose());
        const refreshServiceState = () => {
            void BlogPostManager.refreshUsage();
            void BlogPostManager.refreshNotices();
        };
        const usageTimer = setInterval(refreshServiceState, 30000);
        usageTimer.unref();
        const visibility = webviewView.onDidChangeVisibility(() => {
            BlogPostManager.setSidebarVisible(webviewView.visible);
            refreshServiceState();
        });
        const focus = vscode.window.onDidChangeWindowState(refreshServiceState);
        webviewView.onDidDispose(() => { clearInterval(usageTimer); visibility.dispose(); focus.dispose(); });
        const settingsUpdate = configManager.onDidChange(() => {
            void sendContestMode();
            void this.updateState();
        });
        webviewView.onDidDispose(() => settingsUpdate.dispose());
        const updateDirectory = () => webviewView.webview.postMessage({ type: 'currentDirectory', path: configManager.getCurrentDirectory() });
        const editorUpdate = vscode.window.onDidChangeActiveTextEditor(updateDirectory);
        const workspaceUpdate = vscode.workspace.onDidChangeWorkspaceFolders(updateDirectory);
        webviewView.onDidDispose(() => { editorUpdate.dispose(); workspaceUpdate.dispose(); });
        // We can't easily push to context.subscriptions here without passing context properly,
        // but for now, we rely on the webview's lifecycle.
        // Ideally we should dispose this listener when webview is disposed.
    }

    private async writingLogs(logs: ListedFile[]) {
        const writingActivityRevision = ++this._activityRevision;
        return (await BlogPostManager.withWritingActivity(logs)).map(log => ({ ...log, writingActivityRevision }));
    }
    private async updateWritingActivity(filePath: string) {
        const view = this._view, writingActivityRevision = ++this._activityRevision;
        const writingActivity = await BlogPostManager.writingActivity(filePath);
        if (view && view === this._view && writingActivity) {
            await view.webview.postMessage({ type: 'writingActivity', filePath, writingActivity, writingActivityRevision });
        }
    }
    public async updateState() {
        const revision = ++this._stateRevision;
        const view = this._view;
        if (view && !configManager.contest) {
            const recentLogsPager = this._recentLogs;
            const [page, totalSize, accountLabel, usage, notices] = await Promise.all([
                recentLogsPager.load().then(async page => {
                    // A saved file is ready to show before size scans and account
                    // lookups finish. Page revisions still protect newer results.
                    if (view === this._view && recentLogsPager === this._recentLogs) {
                        await view.webview.postMessage({
                            type: 'recentLogsPage',
                            activeFile: vscode.window.activeTextEditor?.document.uri.fsPath,
                            discovering: this.codeFiles.searching, discoveryFailed: this.codeFiles.failed,
                            ...page,
                        });
                    }
                    return page;
                }),
                storageManager.calculateTotalSize(),
                BlogPostManager.accountLabel(),
                BlogPostManager.usage(),
                BlogPostManager.notices(),
            ]);
            const recentLogs = await this.writingLogs(page.recentLogs);
            if (view !== this._view || revision !== this._stateRevision) return;

            await view.webview.postMessage({
                type: 'updateState',
                activeFile: vscode.window.activeTextEditor?.document.uri.fsPath,
                root: configManager.getRootFolder(),
                windowRoot: configManager.isWindowRoot(),
                currentDirectory: configManager.getCurrentDirectory(),
                isRecording: configManager.isRecording(),
                languages: configManager.getSupportedLanguages(),
                ...page,
                recentLogs,
                totalLogSize: totalSize,
                accountLabel,
                usage,
                notices,
            });
        }
    }
}
