import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import template from './templates/welcome.html';
import css from './templates/welcome.css';
import script from './templates/welcomeScripts.webview.js';

const commands = new Map([
    ['connect', 'psb.connect'],
    ['sample', 'psb.sample'],
    ['history', 'psb.sidebar.focus'],
    ['settings', 'psb.openSettings'],
]);

export class WelcomePanel {
    private static current?: WelcomePanel;
    private busy = false;
    private disposed = false;
    private constructor(private readonly panel: vscode.WebviewPanel) {
        const nonce = randomBytes(24).toString('base64');
        panel.webview.html = template
            .replace('{{csp}}', `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`)
            .replace('{{styles}}', () => `<style nonce="${nonce}">${css}</style>`)
            .replace('{{script}}', () => `<script nonce="${nonce}">${script}</script>`);
        const messages = panel.webview.onDidReceiveMessage(message => { void this.handle(message); });
        panel.onDidDispose(() => {
            this.disposed = true;
            messages.dispose();
            if (WelcomePanel.current === this) WelcomePanel.current = undefined;
        });
    }
    static show(): void {
        if (this.current) { this.current.panel.reveal(); return; }
        this.current = new WelcomePanel(vscode.window.createWebviewPanel(
            'psb.welcome', 'Welcome · PS-Blogself', vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
        ));
    }
    private async handle(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object' || this.busy || this.disposed) return;
        const { type, action } = message as { type?: unknown; action?: unknown };
        if (type !== 'action' || typeof action !== 'string') return;
        const command = commands.get(action);
        if (!command) return;
        this.busy = true;
        let error: string | undefined;
        try { await vscode.commands.executeCommand(command); }
        catch (cause) { error = cause instanceof Error ? cause.message : '작업을 열지 못했습니다. 다시 시도해 주세요.'; }
        finally {
            this.busy = false;
            if (!this.disposed) await this.panel.webview.postMessage({ type: 'actionResult', error });
        }
    }
}
