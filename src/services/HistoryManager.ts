import * as vscode from 'vscode';
import * as path from 'path';
import * as diff from 'diff';
import { storageManager } from '../storage/StorageManager';
import { FileHistory, Snapshot } from '../storage/types';

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

        panel.webview.html = await this._getHtmlForWebview(panel.webview, filePath);
    }

    private static async _getHtmlForWebview(
        webview: vscode.Webview,
        filePath: string,
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
        const diffsHtml = this._generateDiffsHtml(history);

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>수정 기록: ${history.filePath}</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    color: var(--vscode-editor-foreground);
                    background-color: var(--vscode-editor-background);
                }
                .history-entry {
                    margin-bottom: 24px;
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 4px;
                    overflow: hidden;
                }
                .entry-header {
                    background-color: var(--vscode-editor-lineHighlightBackground);
                    padding: 8px 12px;
                    font-size: 13px;
                    display: flex;
                    justify-content: space-between;
                }
                .entry-content {
                    padding: 0;
                    overflow-x: auto;
                    font-family: 'Courier New', Courier, monospace;
                    font-size: 13px;
                    white-space: pre;
                    background-color: var(--vscode-editor-background);
                }
                .diff-line {
                    display: flex;
                    width: 100%;
                }
                .diff-line.added {
                    background-color: rgba(46, 160, 67, 0.2);
                }
                .diff-line.removed {
                    background-color: rgba(248, 81, 73, 0.2);
                    /* optional: maybe don't strike through, just red handling */
                }
                /* Use specific colors for dark mode usually found in VSCode */
                .diff-part {
                    display: inline;
                }
                .added-part {
                    background-color: rgba(46, 160, 67, 0.3);
                    color: var(--vscode-gitDecoration-addedResourceForeground);
                }
                .removed-part {
                    background-color: rgba(248, 81, 73, 0.3);
                    color: var(--vscode-gitDecoration-deletedResourceForeground);
                }
                .unchanged-part {
                    color: var(--vscode-editor-foreground);
                }
                .line-number {
                    width: 40px;
                    text-align: right;
                    padding-right: 10px;
                    color: var(--vscode-editorLineNumber-foreground);
                    user-select: none;
                    flex-shrink: 0;
                }
                .code-text {
                    flex-grow: 1;
                }
                h2 {
                    border-bottom: 1px solid var(--vscode-widget-border);
                    padding-bottom: 8px;
                }
            </style>
        </head>
        <body>
            <h2>파일 수정 기록: ${path.basename(history.filePath)}</h2>
            ${diffsHtml}
        </body>
        </html>`;
    }

    private static _generateDiffsHtml(history: FileHistory): string {
        let html = '';

        // We want to show chronological order, so from start to end?
        // Or reverse chronological (newest first)? User said "git diff-like, continuous (newest order)".
        // "연속적(최신순)" usually means Newest -> Oldest or Oldest -> Newest?
        // "Recent logs" shows newest first. I'll stick to mostly Newest First for now as it's more common in blogs/feeds,
        // BUT git log usually shows newest at top.
        // Wait, user said "continuous (latest order)".

        // Let's generate snapshots comparisons.
        // Compare (N) vs (N-1).

        for (let i = history.snapshots.length - 1; i > 0; i--) {
            const currentSnapshot = history.snapshots[i];
            const prevSnapshot = history.snapshots[i - 1];

            const currentContent = storageManager.reconstructFileContent(history, i);
            const prevContent = storageManager.reconstructFileContent(history, i - 1);

            if (currentContent !== null && prevContent !== null) {
                html += this._renderDiff(prevContent, currentContent, currentSnapshot.timestamp);
            }
        }

        // Also show the initial creation if we want?
        // Or just the first snapshot as "Initial commit"?
        if (history.snapshots.length > 0) {
            const firstSnapshot = history.snapshots[0];
            const firstContent = storageManager.reconstructFileContent(history, 0);
            if (firstContent) {
                html += this._renderDiff('', firstContent, firstSnapshot.timestamp, true);
            }
        }

        return html;
    }

    private static _renderDiff(
        oldText: string,
        newText: string,
        timestamp: number,
        isInitial: boolean = false,
    ): string {
        // Use diff package
        // We can use diffLines for line-by-line diff
        const changes = diff.diffLines(oldText, newText);

        const dateStr = new Date(timestamp).toLocaleString();
        const headerTitle = isInitial ? 'Initial Save' : `Changes at ${dateStr}`;

        let contentHtml = '';
        let lineNumber = 1; // Approximate for display

        changes.forEach((part) => {
            // green for additions, red for deletions
            // grey for common parts
            const colorClass = part.added
                ? 'added-part'
                : part.removed
                  ? 'removed-part'
                  : 'unchanged-part';

            // For line diffs, each 'part.value' can contain multiple lines.
            // visual handling for block

            // Should we split by newline to render line numbers?
            const lines = part.value.split('\n');
            if (lines[lines.length - 1] === '') {
                lines.pop(); // remove trailing empty string from split
            }

            lines.forEach((line) => {
                let lineClass = 'diff-line';
                if (part.added) lineClass += ' added';
                if (part.removed) lineClass += ' removed';

                contentHtml += `<div class="${lineClass}">
                    <!-- <div class="line-number">${lineNumber}</div> --> <!-- Line numbers can be tricky with diffs, skipping for now -->
                    <div class="code-text"><span class="${colorClass}">${this._escapeHtml(line)}</span></div>
                </div>`;
                if (!part.removed) lineNumber++;
            });
        });

        return `
            <div class="history-entry">
                <div class="entry-header">
                    <span class="timestamp">${headerTitle}</span>
                </div>
                <div class="entry-content">
                    ${contentHtml}
                </div>
            </div>
        `;
    }

    private static _escapeHtml(unsafe: string): string {
        return unsafe
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
