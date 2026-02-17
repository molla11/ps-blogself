import * as vscode from 'vscode';
import * as path from 'path';
import * as diff from 'diff';
import { storageManager } from '../storage/StorageManager';
import { BlogPostDraft, FileHistory } from '../types';
import { SidebarProvider } from '../sidebar/SidebarProvider';
import blogPostLoadingHtml from './templates/blogPostLoading.html';
import blogPostMainHtml from './templates/blogPostMain.html';
import blogPostCss from './templates/blogPostMain.css';
import blogPostJs from './templates/blogPostMainScripts.webview.js';

export class BlogPostManager {
    public static readonly viewType = 'psb.blogPost';
    private static _panel: vscode.WebviewPanel | undefined;
    private static _currentFilePath: string | undefined;

    // In-memory draft storage for now (can be moved to storageManager later)
    private static _drafts: Record<string, BlogPostDraft> = {};

    public static async openPage(extensionUri: vscode.Uri, filePath: string) {
        this._currentFilePath = filePath;

        // Create or show panel
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
        } else {
            this._panel = vscode.window.createWebviewPanel(
                BlogPostManager.viewType,
                `Blog Generation: ${path.basename(filePath)}`,
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
                    retainContextWhenHidden: true,
                },
            );

            this._panel.onDidDispose(() => {
                this._panel = undefined;
                this._currentFilePath = undefined;
            });

            this._panel.webview.onDidReceiveMessage(async (message) => {
                await this._handleMessage(message, extensionUri);
            });
        }

        // Load content
        this._panel.webview.html = this._getLoadingHtml();
        const html = await this._getHtmlForWebview(this._panel.webview, filePath, extensionUri);
        this._panel.webview.html = html;
    }

    private static async _handleMessage(message: any, extensionUri: vscode.Uri) {
        if (!this._currentFilePath) return;
        const filePath = this._currentFilePath;

        switch (message.type) {
            case 'saveDraft': {
                const draft = message.draft as BlogPostDraft;
                this._drafts[filePath] = draft;
                // Optional: Persist to globalState or disk
                break;
            }
            case 'generate': {
                await this._generateBlogPost(message.draft);
                break;
            }
            case 'reset': {
                delete this._drafts[filePath];
                const html = await this._getHtmlForWebview(
                    this._panel!.webview,
                    filePath,
                    extensionUri,
                );
                this._panel!.webview.html = html;
                break;
            }
        }
    }

    private static async _generateBlogPost(draft: BlogPostDraft) {
        // Validation
        if (!draft.selectedChangeIndices || draft.selectedChangeIndices.length === 0) {
            vscode.window.showWarningMessage('선택된 변경 사항이 없습니다.');
            return;
        }

        // Mock API Call
        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: '블로그 포스트 생성 중...',
                cancellable: false,
            },
            async (progress) => {
                progress.report({ increment: 0 });

                // Construct Payload (Mock)
                // const payload = { ... };

                // Simulate API delay
                await new Promise((resolve) => setTimeout(resolve, 2000));

                // Calculate baseContent
                const sortedIndices = draft.selectedChangeIndices.sort((a, b) => a - b);
                const firstIndex = sortedIndices[0];
                let baseContent = '';

                if (firstIndex > 0) {
                    const history = await storageManager.getFileHistory(draft.filePath);
                    if (history) {
                        const prev = storageManager.reconstructFileContent(history, firstIndex - 1);
                        baseContent = prev !== null ? prev : '';
                    }
                }
                draft.baseContent = baseContent;

                // Verification for User: Calculate Final Content of the Selection
                let finalContentPreview = '';
                let finalLength = 0;
                let snapshotsInfo = '';
                const history = await storageManager.getFileHistory(draft.filePath);

                if (history) {
                    const lastIndex = sortedIndices[sortedIndices.length - 1];
                    const reconstructed = storageManager.reconstructFileContent(history, lastIndex);
                    if (reconstructed) {
                        finalLength = reconstructed.length;
                        finalContentPreview = reconstructed.substring(0, 100) + '...';
                    }

                    snapshotsInfo = sortedIndices
                        .map((i) => {
                            const snap = history.snapshots[i];
                            if (snap.content) {
                                return `Diff #${i + 1} (Full Content: ${snap.content.length} chars)`;
                            }
                            if (snap.diff) {
                                return `Diff #${i + 1} (Diff: ${snap.diff.newText.length} chars added)`;
                            }
                            return `Diff #${i + 1} (Unknown)`;
                        })
                        .join('\n');

                    // Allow resolved diffs to be part of the draft payload
                    draft.diffs = sortedIndices.map((i) => {
                        const snap = history.snapshots[i];
                        return {
                            index: i,
                            type: snap.content ? 'full' : 'diff',
                            content: snap.content || snap.diff!,
                            timestamp: snap.timestamp,
                        };
                    });
                }

                progress.report({ increment: 100 });
                vscode.window.showInformationMessage('블로그 포스트 생성이 완료되었습니다! (Mock)');

                // Show result (Mock)
                const doc = await vscode.workspace.openTextDocument({
                    content:
                        `# Generated Blog Post via Mock API\n\nBased on ${path.basename(draft.filePath)}\n\n` +
                        `**Selection Config:**\n` +
                        `- Selected Diffs: ${sortedIndices.join(', ')}\n` +
                        `- Base Content Length: ${baseContent.length} ${baseContent.length === 0 ? '(Initial Creation or Start of History)' : ''}\n` +
                        `- Final Content Length: ${finalLength}\n\n` +
                        `**Selected Snapshots Info:**\n${snapshotsInfo}\n\n` +
                        `**Instructions:**\n${draft.instructions}\n\n` +
                        `**Mock Response:**\n(LLM generation would go here based on the above context...)\n\n` +
                        `---\n` +
                        `**Debug: Client Draft (Payload)**\n` +
                        `\`\`\`json\n${JSON.stringify(draft, null, 2)}\n\`\`\``,
                    language: 'markdown',
                });
                await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
            },
        );
    }

    private static _getLoadingHtml(): string {
        return blogPostLoadingHtml;
    }

    private static async _getHtmlForWebview(
        webview: vscode.Webview,
        filePath: string,
        extensionUri: vscode.Uri,
    ): Promise<string> {
        const history = await storageManager.getFileHistory(filePath);
        if (!history) {
            return `<h3>No history found for ${path.basename(filePath)}</h3>`;
        }

        const existingDraft = this._drafts[filePath];
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(
                extensionUri,
                'node_modules',
                '@vscode/codicons',
                'dist',
                'codicon.css',
            ),
        );
        const diffsHtml = await this._generateSelectableDiffsHtml(history, existingDraft);

        const draftJson = JSON.stringify(
            existingDraft || {
                filePath: filePath,
                selectedChangeIndices: history.snapshots.map((_, i) => i),
                instructions: '',
                diffComments: {},
                createdAt: Date.now(),
            },
        );

        return blogPostMainHtml
            .replace(/{{fileName}}/g, path.basename(filePath))
            .replace('{{codiconsUri}}', codiconsUri.toString())
            .replace('<!-- {{css}} -->', `<style>\n${blogPostCss}\n</style>`)
            .replace('{{js}}', `<script>\n${blogPostJs}\n</script>`)
            .replace('{{instructions}}', existingDraft?.instructions || '')
            .replace('{{diffsHtml}}', diffsHtml)
            .replace('/* {{snapshotsJson}} */ []', JSON.stringify(history.snapshots))
            .replace('/* {{draftJson}} */ {}', draftJson);
    }

    private static async _generateSelectableDiffsHtml(
        history: FileHistory,
        draft: BlogPostDraft | undefined,
    ): Promise<string> {
        let html = '';
        const shikiService = (await import('./ShikiService.js')).ShikiService.getInstance();
        await shikiService.init();
        const CONTEXT_SIZE = 3;

        // Iterate backwards from latest snapshot
        for (let i = history.snapshots.length - 1; i >= 0; i--) {
            const currentContent = storageManager.reconstructFileContent(history, i);
            // Logic for previous content:
            // If i > 0, prev is i-1.
            // If i == 0, prev is empty string (all added).
            let prevContent = '';
            if (i > 0) {
                const prev = storageManager.reconstructFileContent(history, i - 1);
                prevContent = prev !== null ? prev : '';
            }

            if (currentContent === null) continue;

            const dateStr = this._formatDate(history.snapshots[i].timestamp);

            // Diff Generation logic reuse (simplified for brevity, matching HistoryManager logic)
            const rawPrevHtml = await shikiService.highlight(prevContent, history.language);
            const rawCurrHtml = await shikiService.highlight(currentContent, history.language);
            const prevLines = this._extractShikiLines(rawPrevHtml);
            const currLines = this._extractShikiLines(rawCurrHtml);

            const diffResult = diff.diffLines(prevContent, currentContent);

            // Reconstruct rows
            let rowsHtml = '';
            let prevIdx = 0;
            let currIdx = 0;
            let added = 0;
            let removed = 0;

            const allRows: any[] = [];
            diffResult.forEach((part) => {
                const count = part.count || 0;
                if (part.added) {
                    added += count;
                    for (let j = 0; j < count; j++) {
                        allRows.push({
                            type: 'added',
                            html: currLines[currIdx + j] || '',
                            lineNumCurr: currIdx + j + 1,
                        });
                    }
                    currIdx += count;
                } else if (part.removed) {
                    removed += count;
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

            // Filter Context
            // If it's a huge file, we only show changes + context.
            // If it's the initial commit (i=0), it might be huge.

            const indicesToShow = new Set<number>();
            // If partial update (i>0), context logic.
            // If i==0, usually we acknowledge it as "Created File", maybe just show first N lines or summary?
            // For consistency let's apply context logic if there are changes.
            // Initial commit is all "added", so it shows everything.

            if (i === 0 && allRows.length > 50) {
                // Truncate logic for initial commit if too large?
                // Let's keep it simple: show all for now, or just top 50.
                for (let r = 0; r < Math.min(allRows.length, 50); r++) {
                    indicesToShow.add(r);
                }
                // Warning msg?
            } else {
                for (let r = 0; r < allRows.length; r++) {
                    if (allRows[r].type !== 'unchanged') {
                        const start = Math.max(0, r - CONTEXT_SIZE);
                        const end = Math.min(allRows.length - 1, r + CONTEXT_SIZE);
                        for (let k = start; k <= end; k++) {
                            indicesToShow.add(k);
                        }
                    }
                }
            }

            let lastShownIndex = -1;
            const sortedIndices = Array.from(indicesToShow).sort((a, b) => a - b);

            if (sortedIndices.length === 0 && allRows.length > 0) {
                rowsHtml =
                    '<tr><td colspan="3" style="padding:10px; opacity:0.6;">No changes to display in context.</td></tr>';
            } else {
                sortedIndices.forEach((idx) => {
                    if (lastShownIndex !== -1 && idx > lastShownIndex + 1) {
                        rowsHtml += `
                            <tr class="diff-line diff-separator">
                                <td class="diff-line-number">...</td>
                                <td class="diff-line-number">...</td>
                                <td class="diff-content" style="color: var(--vscode-descriptionForeground); font-style: italic;">...</td>
                            </tr>`;
                    }
                    const row = allRows[idx];
                    rowsHtml += `
                        <tr class="diff-line diff-${row.type}">
                            <td class="diff-line-number">${row.lineNumPrev || ''}</td>
                            <td class="diff-line-number">${row.lineNumCurr || ''}</td>
                            <td class="diff-content">${row.html}</td>
                        </tr>`;
                    lastShownIndex = idx;
                });
                if (i === 0 && allRows.length > 50) {
                    rowsHtml +=
                        '<tr><td colspan="3" style="text-align:center; opacity:0.6;">(Truncated for initial commit...)</td></tr>';
                }
            }

            // Selection State
            const isSelected = draft?.selectedChangeIndices?.includes(i);
            const comment = draft?.diffComments?.[i] || '';

            // Hidden by default, shown via JS if in range
            const displayStyle = isSelected ? 'block' : 'none';

            // Stats
            const stats = [];
            if (added) {
                stats.push(`<span style="color:var(--vscode-charts-green)">+${added}</span>`);
            }
            if (removed) {
                stats.push(`<span style="color:var(--vscode-charts-red)">-${removed}</span>`);
            }

            html += `
            <div class="diff-selection-root" data-index="${i}" style="display: ${displayStyle}">
                <div class="diff-header">
                     <span class="diff-meta">Diff #${i + 1} (${dateStr}) ${stats.join(' ')}</span>
                     <div class="diff-actions">
                        <button class="icon-btn toggle-comment-btn" data-index="${i}" title="코멘트 추가/닫기">
                            <span class="codicon codicon-comment codicon-comment-flipped"></span>
                        </button>
                     </div>
                </div>
                <div class="diff-container">
                    <table class="diff-table">${rowsHtml}</table>
                </div>
                <div class="comment-area">
                    <textarea class="comment-input comment-input-area" data-index="${i}" placeholder="내용에 대한 코멘트 추가...">${comment}</textarea>
                </div>
            </div>`;
        }
        return html;
    }

    private static _formatDate(timestamp: number): string {
        return new Date(timestamp).toLocaleString();
    }

    private static _extractShikiLines(html: string): string[] {
        const match = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
        const inner = match ? match[1] : html;
        return inner.split('\n');
    }
}
