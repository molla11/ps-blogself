import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as diff from 'diff';
import * as diff2html from 'diff2html';
import { storageManager } from '../storage/StorageManager';
import { FileHistory } from '../storage/types';

export class HistoryManager {
    public static readonly viewType = 'psb.history';

    public static async openHistory(extensionUri: vscode.Uri, filePath: string) {
        const panel = vscode.window.createWebviewPanel(
            HistoryManager.viewType,
            `History: ${path.basename(filePath)}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
            },
        );

        panel.webview.html = await this._getHtmlForWebview(panel.webview, filePath, extensionUri);

        panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'viewSnapshot':
                    await this._openSnapshot(filePath, message.index);
                    break;
                case 'deleteSnapshot':
                    await this._handleDeleteRequest(
                        extensionUri,
                        panel.webview,
                        filePath,
                        message.index,
                    );
                    break;
            }
        });
    }

    private static async _handleDeleteRequest(
        extensionUri: vscode.Uri,
        webview: vscode.Webview,
        filePath: string,
        index: number,
    ) {
        let confirmMessage = '이 로그를 삭제하시겠습니까?';

        // Check if it's the first log (index 0) or middle log
        if (index === 0) {
            confirmMessage =
                '첫 번째 로그를 삭제하면 다음 로그가 새로운 기준점이 됩니다. 삭제하시겠습니까?';
        } else {
            // For middle logs, we can verify if it's the last one by checking history length,
            // but for simplicity, the generic warning about merging is fine or we can check here.
            const history = await storageManager.getFileHistory(filePath);
            if (history && index < history.snapshots.length - 1) {
                confirmMessage =
                    '중간 로그를 삭제하면 더 최근 로그로 수정 사항이 합쳐집니다. 삭제하시겠습니까?';
            }
        }

        const selection = await vscode.window.showWarningMessage(
            confirmMessage,
            { modal: true },
            '삭제',
        );

        if (selection === '삭제') {
            await storageManager.deleteSnapshot(filePath, index);
            // Refresh the view
            webview.html = await this._getHtmlForWebview(webview, filePath, extensionUri);
        }
    }

    private static async _openSnapshot(filePath: string, index: number) {
        const history = await storageManager.getFileHistory(filePath);
        if (!history) {
            vscode.window.showErrorMessage('History not found.');
            return;
        }

        let content = storageManager.reconstructFileContent(history, index);
        if (content === null) {
            vscode.window.showErrorMessage('Failed to reconstruct snapshot content.');
            return;
        }

        // Add Header Comment
        const snapshot = history.snapshots[index];
        const date = new Date(snapshot.timestamp);
        const dateStr = date.toLocaleString('en-US', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            hour12: true,
        });
        const fileName = path.basename(filePath);

        let commentPrefix = '//'; // Default (C, C++, Java, JS, TS, etc.)
        if (
            history.language === 'python' ||
            history.language === 'ruby' ||
            history.language === 'perl' ||
            history.language === 'shellscript'
        ) {
            commentPrefix = '#';
        }

        const header = `${commentPrefix} PS-Blogself History Log: ${fileName} at ${dateStr}\n\n`;
        content = header + content;

        const doc = await vscode.workspace.openTextDocument({
            content: content,
            language: history.language,
        });
        await vscode.window.showTextDocument(doc, {
            preview: true,
            viewColumn: vscode.ViewColumn.Active, // Open in active tab (full screen effect)
        });
    }

    private static async _getHtmlForWebview(
        webview: vscode.Webview,
        filePath: string,
        extensionUri: vscode.Uri,
    ): Promise<string> {
        const history = await storageManager.getFileHistory(filePath);

        if (!history) {
            return `<!DOCTYPE html>
            <html lang="en">
            <body>
                <h1>No history found for ${path.basename(filePath)}</h1>
            </body>
            </html>`;
        }

        // Generate diffs
        const diffsHtml = await this._generateDiffsHtml(history);
        const cssStyles = await this._loadCss(extensionUri);

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>수정 기록: ${history.filePath}</title>
            <style>
                ${cssStyles}
                body {
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    color: var(--vscode-editor-foreground);
                    background-color: var(--vscode-sideBar-background); /* Use sidebar background for the page canvas */
                }
                .d2h-wrapper {
                    /* Color Overrides for VS Code Theme Adaptation */
                    --d2h-bg-color: var(--vscode-editor-background);
                    --d2h-text-color: var(--vscode-editor-foreground);
                    --d2h-border-color: var(--vscode-widget-border);
                    
                    /* Ins/Del Backgrounds */
                    --d2h-ins-bg-color: var(--vscode-diffEditor-insertedLineBackground, rgba(100, 255, 100, 0.2));
                    --d2h-ins-border-color: transparent;
                    --d2h-del-bg-color: var(--vscode-diffEditor-removedLineBackground, rgba(255, 100, 100, 0.2));
                    --d2h-del-border-color: transparent;
                    
                    /* Line Number Colors */
                    --d2h-line-num-text-color: var(--vscode-editorLineNumber-foreground);
                    --d2h-line-num-bg-color: var(--vscode-editor-background);
                    
                    /* Header */
                    --d2h-header-bg-color: var(--vscode-sideBarSectionHeader-background);
                    --d2h-header-text-color: var(--vscode-sideBarSectionHeader-foreground);
                    --d2h-header-border-color: var(--vscode-widget-border);

                    /* Icons */
                    --d2h-icon-color: var(--vscode-icon-foreground);
                }

                /* Apply variables to d2h classes */
                .d2h-file-header {
                    background-color: var(--d2h-header-bg-color) !important;
                    border-bottom: 1px solid var(--d2h-header-border-color) !important;
                    color: var(--d2h-header-text-color) !important;
                }
                .d2h-file-wrapper {
                    border: 1px solid var(--d2h-border-color) !important;
                    margin-bottom: 20px;
                }
                .d2h-code-line-ctn {
                    /* Ensure code text color matches editor */
                    color: var(--vscode-editor-foreground);
                }
                .d2h-code-linenumber {
                    background-color: var(--d2h-line-num-bg-color) !important;
                    color: var(--d2h-line-num-text-color) !important;
                    border: none !important;
                }
                
                /* Diff Blocks (Lines) */
                .d2h-ins {
                    background-color: var(--d2h-ins-bg-color) !important;
                    border-color: var(--d2h-ins-border-color) !important;
                }
                .d2h-del {
                    background-color: var(--d2h-del-bg-color) !important;
                    border-color: var(--d2h-del-border-color) !important;
                    text-decoration: none !important;
                }

                /* Apply line number color to deleted text (dimming it) */
                .d2h-del .d2h-code-line, 
                .d2h-del .d2h-code-line * {
                    color: var(--vscode-editorLineNumber-foreground) !important;
                }

                /* Word-level highlights (Tags inside lines) */
                .d2h-code-line del {
                    background-color: var(--vscode-diffEditor-removedTextBackground, #ff0000) !important;
                    text-decoration: none !important;
                    border-radius: 2px;
                }
                .d2h-code-line ins {
                    background-color: var(--vscode-diffEditor-insertedTextBackground, #00ff00) !important;
                    text-decoration: none !important;
                    border-radius: 2px;
                }
                
                /* Info / Metadata */
                .d2h-info {
                    background-color: var(--vscode-editor-lineHighlightBackground) !important;
                    color: var(--vscode-editor-foreground) !important;
                    border-color: var(--d2h-border-color) !important;
                }

                /* Fix icons color if they use SVG fill */
                .d2h-icon {
                    fill: var(--d2h-icon-color) !important;
                    stroke: var(--d2h-icon-color) !important;
                }
                .d2h-tag {
                    display: none; /* Hide 'FILE', 'RENAMED' etc tags to look cleaner like VSCode */
                }

                h2 {
                    border-bottom: 1px solid var(--vscode-widget-border);
                    padding-bottom: 8px;
                    color: var(--vscode-foreground);
                }

                .history-entry {
                    margin-bottom: 30px;
                    background-color: var(--vscode-editor-background); /* Explicitly set entry background */
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 6px;
                    overflow: hidden;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
                }

                .entry-header {
                    display: flex;
                    justify-content: flex-end;
                    align-items: center;
                    padding: 8px 12px;
                    background-color: var(--vscode-editor-inactiveSelectionBackground); /* Subtle background */
                    border-bottom: 1px solid var(--vscode-widget-border);
                }

                .view-code-btn {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 4px 10px;
                    cursor: pointer;
                    font-size: 11px;
                    border-radius: 2px;
                    font-family: var(--vscode-font-family);
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }

                .view-code-btn:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }

                .delete-btn {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: none;
                    padding: 4px 10px;
                    cursor: pointer;
                    font-size: 11px;
                    border-radius: 2px;
                    font-family: var(--vscode-font-family);
                    display: flex; /* Ensure implementation */
                    align-items: center;
                    margin-right: 8px;
                }

                .delete-btn:hover {
                    background-color: var(--vscode-button-secondaryHoverBackground);
                }
                
                /* Remove bottom margin from d2h-wrapper inside our entry to avoid double spacing */
                .d2h-wrapper {
                   margin-bottom: 0 !important;
                }
                
                .d2h-file-wrapper {
                    margin-bottom: 0 !important;
                    border: none !important;
                    border-radius: 0 !important;
                }
            </style>
        </head>
        <body>
            <h2>파일 수정 기록: ${path.basename(history.filePath)}</h2>
            ${diffsHtml}

            <script>
                const vscode = acquireVsCodeApi();
                
                document.querySelectorAll('.view-code-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const index = parseInt(e.currentTarget.getAttribute('data-index'));
                        vscode.postMessage({
                            type: 'viewSnapshot',
                            index: index
                        });
                    });
                });

                document.querySelectorAll('.delete-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const btn = e.currentTarget;
                        const indexStr = btn.getAttribute('data-index');
                        const index = parseInt(indexStr);
                        
                        // Send request to backend immediately
                        vscode.postMessage({
                            type: 'deleteSnapshot',
                            index: index
                        });
                    });
                });
            </script>
        </body>
        </html>`;
    }

    private static async _loadCss(extensionUri: vscode.Uri): Promise<string> {
        // In a real extension, we might bundle these or use Webview URI.
        // Here we read from node_modules for simplicity as we have access to FS.
        // Assuming we are running in the dev environment where node_modules exists.
        // For production, these should be copied to 'media' or bundled.

        try {
            // Locate node_modules relative to extension root
            // extensionUri points to the root of the workspace usually? No, extension root.
            const diff2htmlCssPath = vscode.Uri.joinPath(
                extensionUri,
                'media',
                'css',
                'diff2html.min.css',
            );
            const highlightCssPath = vscode.Uri.joinPath(
                extensionUri,
                'media',
                'css',
                'github.css',
            );
            // 'github.css' is light, maybe 'github-dark.css' for dark mode?
            // Let's stick to github.css for now or try to find a better one.

            const [d2hCss, hljsCss] = await Promise.all([
                fs.readFile(diff2htmlCssPath.fsPath, 'utf-8'),
                fs.readFile(highlightCssPath.fsPath, 'utf-8'),
            ]);
            return d2hCss + '\n' + hljsCss;
        } catch (e) {
            console.error('Failed to load CSS', e);
            return '';
        }
    }

    private static async _generateDiffsHtml(history: FileHistory): Promise<string> {
        let html = '';
        const fileName = path.basename(history.filePath);

        for (let i = history.snapshots.length - 1; i > 0; i--) {
            const currentSnapshot = history.snapshots[i];

            const currentContent = storageManager.reconstructFileContent(history, i);
            const prevContent = storageManager.reconstructFileContent(history, i - 1);

            if (currentContent !== null && prevContent !== null) {
                const dateStr = new Date(currentSnapshot.timestamp).toLocaleString();
                const patch = diff.createTwoFilesPatch(
                    fileName,
                    fileName,
                    prevContent,
                    currentContent,
                    'Previous',
                    `Changes at ${dateStr}`,
                );

                const diffHtml = diff2html.html(patch, {
                    drawFileList: false,
                    matching: 'lines',
                    outputFormat: 'line-by-line',
                    renderNothingWhenEmpty: false,
                });

                const isLastLog = i === history.snapshots.length - 1;
                const deleteBtn = isLastLog
                    ? ''
                    : `<button class="delete-btn" data-index="${i}" data-is-middle="true">로그 삭제</button>`;

                html += `
                <div class="history-entry">
                    <div class="entry-header">
                        ${deleteBtn}
                        <button class="view-code-btn" data-index="${i}">이 시점의 코드 보기</button>
                    </div>
                    ${diffHtml}
                </div>`;
            }
        }

        // Initial commit
        if (history.snapshots.length > 0) {
            const firstSnapshot = history.snapshots[0];
            const firstContent = storageManager.reconstructFileContent(history, 0);
            if (firstContent) {
                const dateStr = new Date(firstSnapshot.timestamp).toLocaleString();
                // Diff against empty
                const patch = diff.createTwoFilesPatch(
                    fileName,
                    fileName,
                    '',
                    firstContent,
                    'None',
                    `Initial Save at ${dateStr}`,
                );

                const diffHtml = diff2html.html(patch, {
                    drawFileList: false,
                    matching: 'lines',
                    outputFormat: 'line-by-line',
                    renderNothingWhenEmpty: false,
                });

                html += `
                <div class="history-entry">
                    <div class="entry-header">
                        <button class="delete-btn" data-index="0" data-is-middle="false">로그 삭제</button>
                        <button class="view-code-btn" data-index="0">이 시점의 코드 보기</button>
                    </div>
                    ${diffHtml}
                </div>`;
            }
        }

        return html;
    }
}
