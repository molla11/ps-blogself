import * as vscode from 'vscode';
import { configManager } from '../config';
import { storageManager } from '../storage/StorageManager';
import { getSidebarHtml } from './getSidebarHtml';
import { HistoryManager } from '../services/HistoryManager';
import { BlogPostManager } from '../services/BlogPostManager';
import { RecentLogsPager } from './RecentLogsPager';

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'psb.sidebar';

    private _view?: vscode.WebviewView;
    private _recentLogs = new RecentLogsPager(() => storageManager.getRecentFiles());

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _onSelectRootFolder: () => void,
        private readonly _onClearRootFolder: () => void,
        private readonly _onUseWorkspaceRoot: (directory: string) => void,
        private readonly _onToggleRecording: () => void,
        private readonly _onToggleLanguage: (lang: string) => void,
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        const recentLogs = this._recentLogs = new RecentLogsPager(() => storageManager.getRecentFiles());

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = getSidebarHtml(webviewView.webview, this._extensionUri);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            try {
                if (!data || typeof data !== 'object') return;
                switch (data.type) {
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
                        this._onToggleRecording();
                        break;
                    }
                    case 'toggleLanguage': {
                        this._onToggleLanguage(data.value);
                        break;
                    }
                    case 'getInitialData': {
                        await this.updateState();
                        void BlogPostManager.refreshUsage();
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
                            await webviewView.webview.postMessage({ type: 'recentLogsPage', requestId: data.requestId, ...page });
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
                        await HistoryManager.openHistory(this._extensionUri, data.path);
                        break;
                    }
                    case 'manageLogs': {
                        const allLogs = await storageManager.getAllLogs();
                        this._view?.webview.postMessage({
                            type: 'showFullLogs',
                            logs: allLogs,
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
                    case 'sample':
                        await vscode.commands.executeCommand('psb.sample');
                        break;
                    case 'generateBlog': {
                        const logs = await storageManager.getRecentFiles();
                        const target = logs.find((log) => log.filePath === data.path) || logs[0];
                        if (target) {
                            await BlogPostManager.openPage(this._extensionUri, target.filePath);
                        } else {
                            vscode.window.showInformationMessage(
                                '아직 기록이 없습니다. 파일을 저장하면 글을 만들 수 있어요.',
                            );
                        }
                        break;
                    }
                    case 'selectLogForBlog': {
                        await BlogPostManager.openPage(this._extensionUri, data.path);
                        break;
                    }
                }
            } catch (error) {
                vscode.window.showErrorMessage(
                    error instanceof Error ? error.message : String(error),
                );
            }
        });

        // Listen for storage updates to refresh UI
        const disposable = storageManager.onDidUpdateIndex(() => {
            this.updateState();
        });
        webviewView.onDidDispose(() => disposable.dispose());
        const accountUpdate = BlogPostManager.onDidChange(file => { if (!file) void this.updateState(); });
        webviewView.onDidDispose(() => accountUpdate.dispose());
        const refreshUsage = () => {
            if (webviewView.visible && vscode.window.state.focused) void BlogPostManager.refreshUsage();
        };
        const usageTimer = setInterval(refreshUsage, 30000);
        usageTimer.unref();
        const visibility = webviewView.onDidChangeVisibility(refreshUsage);
        const focus = vscode.window.onDidChangeWindowState(refreshUsage);
        const connectionSettings = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('psb.aiMode') || event.affectsConfiguration('psb.apiUrl')) {
                void this.updateState(); refreshUsage();
            }
        });
        webviewView.onDidDispose(() => { clearInterval(usageTimer); visibility.dispose(); focus.dispose(); connectionSettings.dispose(); });
        const settingsUpdate = configManager.onDidChange(() => { void this.updateState(); });
        webviewView.onDidDispose(() => settingsUpdate.dispose());
        const updateDirectory = () => webviewView.webview.postMessage({ type: 'currentDirectory', path: configManager.getCurrentDirectory() });
        const editorUpdate = vscode.window.onDidChangeActiveTextEditor(updateDirectory);
        const workspaceUpdate = vscode.workspace.onDidChangeWorkspaceFolders(updateDirectory);
        webviewView.onDidDispose(() => { editorUpdate.dispose(); workspaceUpdate.dispose(); });
        // We can't easily push to context.subscriptions here without passing context properly,
        // but for now, we rely on the webview's lifecycle.
        // Ideally we should dispose this listener when webview is disposed.
    }

    public async updateState() {
        const view = this._view;
        if (view) {
            const [page, totalSize, accountLabel, usage] = await Promise.all([
                this._recentLogs.load(),
                storageManager.calculateTotalSize(),
                BlogPostManager.accountLabel(),
                BlogPostManager.usage(),
            ]);
            if (view !== this._view) return;

            await view.webview.postMessage({
                type: 'updateState',
                activeFile: vscode.window.activeTextEditor?.document.uri.fsPath,
                root: configManager.getRootFolder(),
                currentDirectory: configManager.getCurrentDirectory(),
                isRecording: configManager.isRecording(),
                languages: configManager.getSupportedLanguages(),
                ...page,
                totalLogSize: totalSize,
                accountLabel,
                usage,
            });
        }
    }
}
