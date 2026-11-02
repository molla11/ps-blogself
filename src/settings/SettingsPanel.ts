import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { configManager } from '../config';
import template from './templates/settings.html';
import css from './templates/settings.css';
import script from './templates/settingsScripts.webview.js';

/** Uses the recorder's effective settings, including this window's path override. */
export class SettingsPanel {
    private static current?: SettingsPanel;
    private queue: Promise<void> = Promise.resolve();
    private disposed = false;
    private constructor(private readonly panel: vscode.WebviewPanel) {
        const nonce = randomBytes(24).toString('base64');
        panel.webview.html = template.replace('{{csp}}', `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`)
            .replace('{{styles}}', () => `<style nonce="${nonce}">${css}</style>`)
            .replace('{{script}}', () => `<script nonce="${nonce}">${script}</script>`);
        const subscriptions = [
            configManager.onDidChange(() => this.render()),
            vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('psb.prepareOnReview')) this.render(); }),
            vscode.window.onDidChangeActiveTextEditor(() => this.render()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.render()),
            panel.webview.onDidReceiveMessage(message => {
                this.queue = this.queue.then(async () => {
                    if (this.disposed) return;
                    try {
                        const applied = await this.handle(message);
                        this.render();
                        void panel.webview.postMessage({ type: 'saved', id: message?.id, field: message?.field, applied: applied !== false });
                    } catch (error) {
                        void panel.webview.postMessage({ type: 'error', id: message?.id, message: error instanceof Error ? error.message : '설정을 저장하지 못했습니다.' });
                    }
                });
            }),
        ];
        panel.onDidDispose(() => { this.disposed = true; SettingsPanel.current = undefined; subscriptions.forEach(item => item.dispose()); });
    }
    static show() {
        if (this.current) { this.current.panel.reveal(); return; }
        const panel = vscode.window.createWebviewPanel('psb.settings', 'PS-Blogself 설정', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
        this.current = new SettingsPanel(panel);
    }
    private render() {
        if (this.disposed) return;
        void this.panel.webview.postMessage({ type: 'settings',
            root: configManager.getRootFolder(), currentDirectory: configManager.getCurrentDirectory(), windowRoot: configManager.isWindowRoot(),
            recording: configManager.isRecording(), extensions: configManager.getSupportedLanguages(),
            prepareOnReview: vscode.workspace.getConfiguration('psb').get('prepareOnReview', true),
        });
    }
    private async handle(message: any) {
        if (!message || typeof message.type !== 'string' || JSON.stringify(message).length > 10000) throw new Error('설정 요청을 확인해 주세요.');
        switch (message.type) {
            case 'ready': break;
            case 'chooseFolder': {
                const directory = configManager.getRootFolder() || configManager.getCurrentDirectory();
                const result = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '활성 경로로 설정', defaultUri: directory ? vscode.Uri.file(directory) : undefined });
                if (result?.[0]) await configManager.setRootFolder(result[0].fsPath);
                return !!result?.[0];
            }
            case 'currentDirectory': {
                const directory = configManager.getCurrentDirectory();
                if (directory) await configManager.setRootFolder(directory, true);
                break;
            }
            case 'resetRoot': await configManager.setRootFolder(''); break;
            case 'save':
                switch (message.field) {
                    case 'root':
                        if (typeof message.value !== 'string') throw new Error('활성 경로를 확인해 주세요.');
                        await configManager.setRootFolder(message.value); break;
                    case 'extensions': await configManager.setSupportedLanguages(message.value); break;
                    case 'recording':
                        if (typeof message.value !== 'boolean') throw new Error('기록 여부를 확인해 주세요.');
                        await configManager.setRecording(message.value); break;
                    case 'prepareOnReview':
                        if (typeof message.value !== 'boolean') throw new Error('미리 준비 여부를 확인해 주세요.');
                        await vscode.workspace.getConfiguration('psb').update('prepareOnReview', message.value, vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
                        break;
                    default: throw new Error('지원하지 않는 설정입니다.');
                }
                break;
            default: throw new Error('지원하지 않는 설정 요청입니다.');
        }
    }
}
