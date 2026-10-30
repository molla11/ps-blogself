import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import sidebarHtml from './templates/sidebar.html';
import sidebarCss from './templates/sidebar.css';
import sidebarJs from './templates/sidebarScripts.webview.js';

export function getSidebarHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const codiconsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css'),
    );

    const nonce = randomBytes(24).toString('base64');
    return sidebarHtml
        .replace(
            '{{csp}}',
            `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`,
        )
        .replace('{{codiconsUri}}', codiconsUri.toString())
        .replace('<!-- {{css}} -->', () => `<style nonce="${nonce}">\n${sidebarCss}\n</style>`)
        .replace('{{js}}', () => `<script nonce="${nonce}">\n${sidebarJs}\n</script>`);
}
