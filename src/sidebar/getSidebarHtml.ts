import * as vscode from 'vscode';
import sidebarHtml from './templates/sidebar.html';
import sidebarCss from './templates/sidebar.css';
import sidebarJs from './templates/sidebarScripts.webview.js';

export function getSidebarHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const codiconsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(
            extensionUri,
            'node_modules',
            '@vscode/codicons',
            'dist',
            'codicon.css',
        ),
    );

    return sidebarHtml
        .replace('{{codiconsUri}}', codiconsUri.toString())
        .replace('<!-- {{css}} -->', `<style>\n${sidebarCss}\n</style>`)
        .replace('{{js}}', `<script>\n${sidebarJs}\n</script>`);
}
