import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import template from './templates/welcome.html';
import css from './templates/welcome.css';
import script from './templates/welcomeScripts.webview.js';
import type { CodeDiscovery } from '../sidebar/CodeDiscovery';
import { storageManager } from '../storage/StorageManager';
import { BlogPostManager } from '../services/BlogPostManager';

const commands = new Map([
    ['connect', 'psb.connect'],
    ['sample', 'psb.sample'],
    ['settings', 'psb.openSettings'],
    ['createFile', 'psb.createCodeFile'],
    ['openFolder', 'psb.openFolderFromWelcome'],
]);

export class WelcomePanel {
    private static current?: WelcomePanel;
    private busy = false;
    private disposed = false;
    private ready = false;
    private filesRevision = 0;
    private constructor(private readonly panel: vscode.WebviewPanel, private readonly codeFiles: CodeDiscovery, private readonly extensionUri: vscode.Uri) {
        const nonce = randomBytes(24).toString('base64');
        const discovery = codeFiles.onDidChange(() => this.updateFiles());
        const history = storageManager.onDidUpdateIndex(() => this.updateFiles());
        const workspace = vscode.workspace.onDidChangeWorkspaceFolders(() => this.updateFiles());
        panel.onDidChangeViewState(() => { if (panel.visible) this.updateFiles(); });
        const messages = panel.webview.onDidReceiveMessage(message => { void this.handle(message); });
        panel.webview.html = template
            .replace('{{csp}}', `default-src 'none'; img-src ${panel.webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`)
            .replace('{{logoUri}}', () => panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'image', 'logo_ps_blogself1.png')).toString())
            .replace('{{styles}}', () => `<style nonce="${nonce}">${css}</style>`)
            .replace('{{script}}', () => `<script nonce="${nonce}">${script}</script>`);
        panel.onDidDispose(() => {
            this.disposed = true;
            messages.dispose();
            discovery.dispose();
            history.dispose();
            workspace.dispose();
            if (WelcomePanel.current === this) WelcomePanel.current = undefined;
        });
    }
    static show(codeFiles: CodeDiscovery, extensionUri: vscode.Uri): void {
        if (this.current) { this.current.panel.reveal(); return; }
        const images = vscode.Uri.joinPath(extensionUri, 'media', 'image');
        this.current = new WelcomePanel(vscode.window.createWebviewPanel(
            'psb.welcome', 'Welcome · PS-Blogself', vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [images] },
        ), codeFiles, extensionUri);
    }
    private async updateFiles() {
        if (!this.ready || this.disposed || !this.panel.visible) return;
        const revision = ++this.filesRevision;
        const { files, searching, failed } = this.codeFiles;
        const dated = files.length ? await this.codeFiles.currentFiles(await storageManager.getRecentFiles()) : [];
        if (this.disposed || !this.panel.visible || revision !== this.filesRevision) return;
        void this.panel.webview.postMessage({
            type: 'codeFiles', total: dated.length, searching, failed, hasFolder: !!vscode.workspace.workspaceFolders?.length,
            files: dated.slice(0, 4).map(({ fileName, filePath, language, lastModified }) => ({ fileName, filePath, language, lastModified })),
        });
    }
    private async chooseFile() {
        const items = async () => {
            await this.codeFiles.whenScanFinishes();
            const files = await this.codeFiles.currentFiles(await storageManager.getRecentFiles());
            if (!files.length) {
                await this.updateFiles();
                throw new Error('파일 목록이 바뀌었습니다. 현재 폴더를 다시 확인해 주세요.');
            }
            return files.map(file => ({
                label: file.fileName, description: vscode.workspace.asRelativePath(file.filePath, true), path: file.filePath,
            }));
        };
        const choice = await vscode.window.showQuickPick(items(), { title: '코드 목록', placeHolder: '열 코드 파일을 선택하세요.', matchOnDescription: true });
        if (choice) await vscode.window.showTextDocument(vscode.Uri.file(choice.path), { preview: false });
    }
    private async handle(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object' || this.disposed) return;
        const { type, action, path } = message as { type?: unknown; action?: unknown; path?: unknown };
        if (type === 'ready') {
            this.codeFiles.start();
            this.ready = true;
            this.updateFiles();
            return;
        }
        if (this.busy || type !== 'action' || typeof action !== 'string') return;
        const command = commands.get(action);
        if (!command && !['chooseFile', 'openFile', 'write'].includes(action)) return;
        this.busy = true;
        let error: string | undefined;
        try {
            if (command) await vscode.commands.executeCommand(command);
            else if (action === 'chooseFile') await this.chooseFile();
            else {
                const file = this.codeFiles.files.find(file => file.filePath === path);
                if (!file) throw new Error('파일 목록이 바뀌었습니다. 목록에서 다시 선택해 주세요.');
                if (action === 'write') await BlogPostManager.openPage(this.extensionUri, file.filePath, { language: file.language });
                else await vscode.window.showTextDocument(vscode.Uri.file(file.filePath), { preview: false });
            }
        }
        catch (cause) { error = cause instanceof Error ? cause.message : '작업을 열지 못했습니다. 다시 시도해 주세요.'; }
        finally {
            this.busy = false;
            if (!this.disposed) await this.panel.webview.postMessage({ type: 'actionResult', error });
        }
    }
}
