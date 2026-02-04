import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as diff from 'diff';
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
        // We only need basic diff styling since Shiki handles syntax highlighting
        // Shiki's default output needs to be wrapped or styled to fit
        return `
            /* Shiki Diff Styling */
            .diff-container {
                font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
                font-size: var(--vscode-editor-font-size, 14px);
                line-height: normal; /* Adjust if needed */
                background-color: var(--vscode-editor-background);
                border-radius: 4px;
                overflow-x: auto;
                margin-bottom: 20px;
            }
            .diff-table {
                width: 100%;
                border-collapse: collapse;
            }
            .diff-line {
                white-space: pre;
            }
            .diff-line-number {
                width: 40px;
                text-align: right;
                padding-right: 10px;
                color: var(--vscode-editorLineNumber-foreground);
                user-select: none;
                vertical-align: top;
                border-right: 1px solid var(--vscode-editorGutter-background);
            }
            .diff-content {
                padding-left: 10px;
                vertical-align: top;
                color: var(--vscode-editor-foreground);
            }
            
            /* Highlighting Backgrounds */
            .diff-added {
                background-color: var(--vscode-diffEditor-insertedLineBackground, rgba(100, 255, 100, 0.2));
            }
            .diff-removed {
                background-color: var(--vscode-diffEditor-removedLineBackground, rgba(255, 100, 100, 0.2));
            }
            .diff-unchanged {
                /* No background or transparent */
            }

            /* Shiki Code Styles overrides if needed */
            pre.shiki {
                margin: 0;
                padding: 0;
                background-color: transparent !important; /* Let line background show through */
            }
            .shiki code {
                background-color: transparent !important;
            }
        `;
    }

    private static async _generateDiffsHtml(history: FileHistory): Promise<string> {
        let html = '';
        const fileName = path.basename(history.filePath);
        const shikiService = (await import('./ShikiService.js')).ShikiService.getInstance();
        await shikiService.init();

        const CONTEXT_SIZE = 3; // Number of lines to show around changes

        // Common CSS for separator
        const separatorHtml = `
            <tr class="diff-line diff-separator">
                <td class="diff-line-number">...</td>
                <td class="diff-line-number">...</td>
                <td class="diff-content" style="color: var(--vscode-descriptionForeground); font-style: italic;">...</td>
            </tr>`;

        for (let i = history.snapshots.length - 1; i > 0; i--) {
            const currentContent = storageManager.reconstructFileContent(history, i);
            const prevContent = storageManager.reconstructFileContent(history, i - 1);

            if (currentContent !== null && prevContent !== null) {
                const dateStr = new Date(history.snapshots[i].timestamp).toLocaleString();

                const rawPrevHtml = await shikiService.highlight(prevContent, history.language);
                const rawCurrHtml = await shikiService.highlight(currentContent, history.language);

                const prevLines = this._extractShikiLines(rawPrevHtml);
                const currLines = this._extractShikiLines(rawCurrHtml);

                const diffResult = diff.diffLines(prevContent, currentContent);

                // 1. Flatten into rows
                interface DiffRow {
                    type: 'added' | 'removed' | 'unchanged';
                    html: string;
                    lineNumPrev?: number;
                    lineNumCurr?: number;
                }
                const allRows: DiffRow[] = [];
                let prevIdx = 0;
                let currIdx = 0;

                diffResult.forEach((part) => {
                    const count = part.count || 0;
                    if (part.added) {
                        for (let j = 0; j < count; j++) {
                            allRows.push({
                                type: 'added',
                                html: currLines[currIdx + j] || '',
                                lineNumCurr: currIdx + j + 1,
                            });
                        }
                        currIdx += count;
                    } else if (part.removed) {
                        for (let j = 0; j < count; j++) {
                            allRows.push({
                                type: 'removed',
                                html: prevLines[prevIdx + j] || '',
                                lineNumPrev: prevIdx + j + 1,
                            });
                        }
                        prevIdx += count;
                    } else {
                        for (let j = 0; j < count; j++) {
                            allRows.push({
                                type: 'unchanged',
                                html: currLines[currIdx + j] || '',
                                lineNumPrev: prevIdx + j + 1,
                                lineNumCurr: currIdx + j + 1,
                            });
                        }
                        prevIdx += count;
                        currIdx += count;
                    }
                });

                // 2. Identify rows to show (Changes + Context)
                const indicesToShow = new Set<number>();
                for (let r = 0; r < allRows.length; r++) {
                    if (allRows[r].type !== 'unchanged') {
                        // Mark range [r - context, r + context]
                        const start = Math.max(0, r - CONTEXT_SIZE);
                        const end = Math.min(allRows.length - 1, r + CONTEXT_SIZE);
                        for (let k = start; k <= end; k++) {
                            indicesToShow.add(k);
                        }
                    }
                }

                // 3. Render filtered rows
                let diffTableRows = '';
                let lastShownIndex = -1;

                // Always show first few lines if context puts us close to start?
                // Or maybe just strictly separate.

                // If nothing changed (unlikely with diffLines logic unless empty), show nothing?
                // Better: if no changes found, showing nothing implies identical files.
                // But normally we only have entries if there are changes (unless logic allows empty diffs).

                const sortedIndices = Array.from(indicesToShow).sort((a, b) => a - b);

                // Only if file is small, showing all might be better?
                // Let's stick to context logic.

                if (sortedIndices.length === 0 && allRows.length > 0) {
                    // No diffs? Show message or first few lines?
                    diffTableRows = `<tr><td colspan="3" style="padding: 10px; color: var(--vscode-descriptionForeground);">No changes detected.</td></tr>`;
                } else {
                    sortedIndices.forEach((idx, arrayPos) => {
                        // Check for gap
                        if (lastShownIndex !== -1 && idx > lastShownIndex + 1) {
                            diffTableRows += separatorHtml;
                        }

                        const row = allRows[idx];
                        const className = `diff-line diff-${row.type}`;
                        const numP = row.lineNumPrev !== undefined ? row.lineNumPrev : '';
                        const numC = row.lineNumCurr !== undefined ? row.lineNumCurr : '';

                        diffTableRows += `
                            <tr class="${className}">
                                <td class="diff-line-number">${numP}</td>
                                <td class="diff-line-number">${numC}</td>
                                <td class="diff-content">${row.html}</td>
                            </tr>`;

                        lastShownIndex = idx;
                    });
                }

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
                    <div class="diff-container">
                        <table class="diff-table">
                            ${diffTableRows}
                        </table>
                    </div>
                </div>`;
            }
        }

        // Initial commit - Show all content (It's all "added")
        if (history.snapshots.length > 0) {
            const firstContent = storageManager.reconstructFileContent(history, 0);
            if (firstContent) {
                const rawLines = await shikiService.highlight(firstContent, history.language);
                const lines = this._extractShikiLines(rawLines);

                let tableRows = '';
                lines.forEach((line, idx) => {
                    tableRows += `
                        <tr class="diff-line diff-added">
                            <td class="diff-line-number"></td>
                            <td class="diff-line-number">${idx + 1}</td>
                            <td class="diff-content">${line}</td>
                        </tr>`;
                });

                html += `
                <div class="history-entry">
                    <div class="entry-header">
                        <button class="delete-btn" data-index="0" data-is-middle="false">로그 삭제</button>
                        <button class="view-code-btn" data-index="0">이 시점의 코드 보기</button>
                    </div>
                     <div class="diff-container">
                        <table class="diff-table">
                            ${tableRows}
                        </table>
                    </div>
                </div>`;
            }
        }

        return html;
    }

    private static _extractShikiLines(html: string): string[] {
        // Strip pre/code tags
        const match = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
        const inner = match ? match[1] : html;

        // Shiki output (v1.x) with theme usually looks like:
        // <span class="line">...</span>\n<span class="line">...</span>
        // BUT, createHighlighter default output depends on configuration.
        // Assuming line-based spans.
        // If simply raw HTML with newlines, split by \n works for basic text,
        // but rich text might have embedded newlines in spans?
        // Shiki usually escapes newlines or puts them outside line spans.
        // Let's try splitting by \n.

        return inner.split('\n');
    }
}
