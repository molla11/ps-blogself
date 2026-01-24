import * as vscode from 'vscode';
import { configManager } from '../config';
import { storageManager } from '../storage/StorageManager';
import { getSidebarHtml } from './getSidebarHtml';

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'psb.sidebar';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _onSelectRootFolder: () => void,
        private readonly _onClearRootFolder: () => void,
        private readonly _onUseWorkspaceRoot: () => void,
        private readonly _onToggleRecording: () => void,
        private readonly _onToggleLanguage: (lang: string) => void,
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = getSidebarHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'selectRootFolder': {
                    this._onSelectRootFolder();
                    break;
                }
                case 'clearRootFolder': {
                    this._onClearRootFolder();
                    break;
                }
                case 'useWorkspaceRoot': {
                    this._onUseWorkspaceRoot();
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
                    this.updateState();
                    break;
                }
                case 'openFile': {
                    vscode.workspace.openTextDocument(data.path).then((doc) => {
                        vscode.window.showTextDocument(doc);
                    });
                    break;
                }
            }
        });

        // Listen for storage updates to refresh UI
        const disposable = storageManager.onDidUpdateIndex(() => {
            this.updateState();
        });
        // We can't easily push to context.subscriptions here without passing context properly,
        // but for now, we rely on the webview's lifecycle.
        // Ideally we should dispose this listener when webview is disposed.
    }

    public async updateState() {
        if (this._view) {
            const recentLogs = await storageManager.getRecentFiles();
            const totalSize = await storageManager.calculateTotalSize();

            this._view.webview.postMessage({
                type: 'updateState',
                root: configManager.getRootFolder(),
                isRecording: configManager.isRecording(),
                languages: configManager.getSupportedLanguages(),
                recentLogs: recentLogs,
                totalLogSize: totalSize,
            });
        }
    }
}
