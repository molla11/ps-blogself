import * as vscode from 'vscode';
import * as path from 'path';
import * as diff from 'diff';
import { storageManager } from '../storage/StorageManager';
import { BlogPostDraft, FileHistory } from '../types';
import { SidebarProvider } from '../sidebar/SidebarProvider';

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
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Loading...</title>
            <style>
                body {
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    font-family: var(--vscode-font-family);
                }
            </style>
        </head>
        <body>
            Loading Blog Generator...
        </body>
        </html>`;
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
        const css = await this._loadCss(extensionUri);
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

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Blog Gen: ${path.basename(filePath)}</title>
            <link href="${codiconsUri}" rel="stylesheet" />
            <style>
                ${css}
                html {
                    height: 100%;
                    margin: 0;
                    padding: 0;
                    overflow: hidden; /* Hide outer scrollbar */
                }
                body { 
                    height: 100%;
                    margin: 0;
                    padding: 20px;
                    box-sizing: border-box;
                    overflow-y: scroll; /* Force inner scrollbar */
                    
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-editor-foreground);
                    background-color: var(--vscode-editor-background);
                }
                h2 { border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 10px; }
                .controls { margin-bottom: 5px; border: 1px solid var(--vscode-widget-border); padding: 10px; border-radius: 4px; }
                textarea { width: 100%; height: 80px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
                button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; }
                button:hover { background: var(--vscode-button-hoverBackground); }
                .inline-btn { background: none; color: var(--vscode-textLink-foreground); padding: 0; margin: 0; }
                .inline-btn:hover { text-decoration: underline; background: none; }
                .action-bar { display: flex; justify-content: space-between; align-items: center; margin-top: 20px; margin-bottom: 10px; }
                #range-info { font-size: 1.2em; font-weight: bold; color: var(--vscode-editor-foreground); }
                #instructions-container { display: none; margin-top: 10px; }
                #instructions-container.visible { display: block; }
                .comment-area { display: none; margin-top: 5px; }
                .comment-area.visible { display: block; }
            </style>
        </head>
        <body>
            <h2>블로그 생성하기 (${path.basename(filePath)})</h2>
            <div class="controls">
                <!-- Header with Label and Credits -->
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                    <label style="font-weight: bold; font-size: 1.2em;">Diff 선택:</label>
                </div>
                <div class="timeline-container" id="timeline">
                    <div class="timeline-track"></div>
                    <div class="timeline-range" id="timeline-range"></div>
                    <!-- Dots will be injected here -->
                </div>
                <!-- Range info moved to action bar -->
            </div>
            <!-- Separate Credit div removed -->

            <div class="action-bar">
                <span id="range-info">타임라인에서 구간을 선택하세요</span>
                <div style="display: flex; gap: 10px; align-items: center;">
                    <span class="badge" style="background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 2px 6px; border-radius: 4px; font-size: 0.9em;">Credits: 10</span>
                    <button id="generate-btn">블로그 생성하기 (Mock)</button>
                </div>
            </div>

            <div style="margin-top: 10px; margin-bottom: 20px;">
                <button id="toggle-instructions-btn" class="inline-btn">+ 설명 추가하기(Optional, 지문/풀이 설명, 문제 제한 등)</button>
                <div id="instructions-container">
                    <label for="instructions" style="display:block; margin-bottom:5px;">설명 추가하기:</label>
                    <textarea id="instructions" rows="3" placeholder="Click here to add extra context or specific requests...">${
                        existingDraft?.instructions || ''
                    }</textarea>
                </div>
            </div>

            <div id="diff-list">
                ${diffsHtml}
            </div>

            <!-- Buttons moved up -->

            <script>
                const vscode = acquireVsCodeApi();
                const snapshots = ${JSON.stringify(history.snapshots)};
                const draft = ${JSON.stringify(
                    existingDraft || {
                        filePath: filePath,
                        selectedChangeIndices: history.snapshots.map((_, i) => i),
                        instructions: '',
                        diffComments: {},
                        createdAt: Date.now(),
                    },
                )};

                // Elements
                const timeline = document.getElementById('timeline');
                const rangeInfo = document.getElementById('range-info');
                const instructionsContainer = document.getElementById('instructions-container');
                const toggleInstructionsBtn = document.getElementById('toggle-instructions-btn');
                const instructionsTextarea = document.getElementById('instructions');
                const generateBtn = document.getElementById('generate-btn');

                // Initial UI state for instructions
                if (draft.instructions && draft.instructions.trim() !== '') {
                    instructionsContainer.classList.add('visible');
                    toggleInstructionsBtn.textContent = '- 설명 숨기기';
                } else {
                    instructionsContainer.classList.remove('visible');
                    toggleInstructionsBtn.textContent = '+ 설명 추가하기(Optional, 지문/풀이 설명, 문제 제한 등)';
                }

                // Event Listeners
                toggleInstructionsBtn.addEventListener('click', () => {
                   const isVisible = instructionsContainer.classList.contains('visible');
                   if (isVisible) {
                       instructionsContainer.classList.remove('visible');
                       toggleInstructionsBtn.textContent = '+ 설명 추가하기(Optional, 지문/풀이 설명, 문제 제한 등)';
                   } else {
                       instructionsContainer.classList.add('visible');
                       toggleInstructionsBtn.textContent = '- 설명 숨기기';
                       instructionsTextarea.focus();
                   }
                });
                
                // Toggle Diff Comment
                document.querySelectorAll('.toggle-comment-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const index = e.currentTarget.dataset.index;
                        const commentArea = document.getElementById('comment-area-' + index);
                        if (commentArea) {
                             const isVisible = commentArea.classList.contains('visible');
                             if (isVisible) {
                                 commentArea.classList.remove('visible');
                             } else {
                                 commentArea.classList.add('visible');
                                 // Focus textarea
                                 const textarea = commentArea.querySelector('textarea');
                                 if (textarea) textarea.focus();
                             }
                        }
                    });
                });

                // Instructions
                document.getElementById('instructions').addEventListener('input', (e) => {
                    draft.instructions = e.target.value;
                    saveDraft();
                });

                // Comments (Delegate for dynamic availability? No, diff list is static structure, just toggled display)
                // Actually, Diff List is populated by _generateSelectableDiffsHtml (server side). 
                // We just hide/show them. So listeners can be attached on load.
                document.querySelectorAll('.comment-input-area').forEach(area => {
                    area.addEventListener('input', (e) => {
                        const index = parseInt(e.target.dataset.index);
                        draft.diffComments[index] = e.target.value;
                        saveDraft();
                    });
                });

                // Buttons
                document.getElementById('generate-btn').addEventListener('click', () => {
                    vscode.postMessage({ type: 'saveDraft', draft });
                    vscode.postMessage({ type: 'generate', draft });
                });




                
                function saveDraft() {
                    vscode.postMessage({ type: 'saveDraft', draft: draft });
                }

                // Render Timeline
                function renderTimeline() {
                    // Remove existing dots
                    document.querySelectorAll('.timeline-dot').forEach(e => e.remove());

                    const total = snapshots.length;
                    if (total === 0) return;

                    snapshots.forEach((snap, i) => {
                        const dot = document.createElement('div');
                        dot.className = 'timeline-dot';
                        // Position based on index (even spacing for now)
                        // padding 10px on sides means 20px total subtraction
                        // but simplest is just percentage
                        const left = (i / (total - 1)) * 100; // 0 to 100
                        dot.style.left = \`calc(10px + (100% - 20px) * \${left/100})\`;
                        
                        dot.dataset.index = i;

                        // Tooltip
                        const tooltip = document.createElement('div');
                        tooltip.className = 'timeline-tooltip';
                        const date = new Date(snap.timestamp);
                        tooltip.textContent = \`Diff #\${i} (\${date.toLocaleTimeString()})\`;
                        dot.appendChild(tooltip);

                        // Events
                        dot.addEventListener('mousedown', handleDotMouseDown);
                        dot.addEventListener('mouseenter', handleDotHover);
                        dot.addEventListener('mouseleave', handleDotLeave);
                        
                        timeline.appendChild(dot);
                    });
                    
                    updateSelectionUI();
                }

                // Hover Logic
                function handleDotHover(e) {
                    if (isDragging) return; // Don't interfere if dragging? Or maybe we should? No, stick to drag.
                    const index = parseInt(e.target.dataset.index);
                    
                    // Show ONLY this diff
                    document.querySelectorAll('.diff-selection-root').forEach(el => {
                        const idx = parseInt(el.dataset.index);
                        if (idx === index) {
                            el.style.display = 'block';
                            // Add a temporary highlight class if needed?
                        } else {
                            el.style.display = 'none';
                        }
                    });
                }

                function handleDotLeave(e) {
                    if (isDragging) return;
                    // Restore Selection View
                    updateSelectionUI();
                }

                // Interaction Logic
                let isDragging = false;
                let dragTargetIndex = -1; // 0 for start, 1 for end
                let tempIndices = [...draft.selectedChangeIndices];

                function updateSelectionUI() {
                    const indices = draft.selectedChangeIndices.sort((a,b) => a-b);
                    
                    // Update Dots
                    document.querySelectorAll('.timeline-dot').forEach(dot => {
                        const idx = parseInt(dot.dataset.index);
                        dot.classList.remove('active', 'in-range');
                        if (indices.includes(idx)) {
                            if (idx === indices[0] || idx === indices[indices.length - 1]) {
                                dot.classList.add('active');
                            } else {
                                dot.classList.add('in-range');
                            }
                        }
                    });

                    // Update Range Bar
                    if (indices.length > 0) {
                         const startDot = document.querySelector(\`.timeline-dot[data-index="\${indices[0]}"]\`);
                         const endDot = document.querySelector(\`.timeline-dot[data-index="\${indices[indices.length-1]}"]\`);
                         if (startDot && endDot) {
                             const rangeElem = document.getElementById('timeline-range');
                             rangeElem.style.left = startDot.style.left;
                             rangeElem.style.width = \`calc(\${endDot.style.left} - \${startDot.style.left})\`;
                             if (indices.length === 1) rangeElem.style.width = '0px';
                         }
                    } else {
                        document.getElementById('timeline-range').style.width = '0px';
                    }

                    // Show/Hide Diffs
                    document.querySelectorAll('.diff-selection-root').forEach(el => {
                        const idx = parseInt(el.dataset.index);
                        if (indices.includes(idx)) {
                             el.style.display = 'block';
                        } else {
                             el.style.display = 'none';
                        }
                    });
                    
                    // Calculate Payload Size
                    // 1. Base Content Size
                    const firstIndex = indices[0];
                    let baseSize = 0;
                    
                    // Helper to get length at a specific index
                    const getContentLength = (idx) => {
                        if (idx < 0) return 0;
                        // Find nearest full full snapshot <= idx
                        let startIdx = -1;
                        let len = 0;
                        for (let i = idx; i >= 0; i--) {
                            if (snapshots[i].content) {
                                startIdx = i;
                                len = snapshots[i].content.length;
                                break;
                            }
                        }
                        // If no full snapshot found, start from 0 (empty)
                        if (startIdx === -1) {
                            startIdx = -1; 
                            len = 0;
                        }
                        
                        // Apply diffs forward
                        for (let i = startIdx + 1; i <= idx; i++) {
                            const d = snapshots[i].diff;
                            if (d) {
                                len = len - (d.end - d.start) + d.newText.length;
                            } else if (snapshots[i].content) {
                                // Should be handled by startIdx logic, but safeguard
                                len = snapshots[i].content.length;
                            }
                        }
                        return len;
                    };

                    if (firstIndex > 0) {
                        baseSize = getContentLength(firstIndex - 1);
                    }

                    // 2. Selected Diffs Size
                    let diffsSize = 0;
                    indices.forEach(idx => {
                        const snap = snapshots[idx];
                        if (snap.content) diffsSize += snap.content.length;
                        else if (snap.diff) diffsSize += snap.diff.newText.length;
                    });
                    
                    const totalSize = baseSize + diffsSize;
                    
                    const formatSize = (bytes) => {
                         if (bytes === 0) return '0 B';
                         const k = 1024;
                         const sizes = ['B', 'KB', 'MB'];
                         const i = Math.floor(Math.log(bytes) / Math.log(k));
                         return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
                    };
                    const sizeStr = formatSize(totalSize);
                    // Optional: Show breakdown? "1.5 KB (Base: 1.0 KB)"
                    // User requested to hide breakdown:
                    // const fullSizeStr = \`\${sizeStr} (Base: \${formatSize(baseSize)})\`;

                    if (indices.length === 0) {
                        rangeInfo.textContent = '타임라인에서 구간을 선택하세요';
                    } else if (indices.length === 1) {
                         rangeInfo.textContent = \`Diff #\${indices[0] + 1} 선택됨 (\${sizeStr})\`;
                    } else {
                         rangeInfo.textContent = \`Diff #\${indices[0] + 1}~\${indices[indices.length-1] + 1} 선택됨 (\${sizeStr})\`;
                    }
                }

                function handleDotMouseDown(e) {
                    e.stopPropagation();
                    const index = parseInt(e.target.dataset.index);
                    
                    // Logic:
                    // If no selection: start selection (start = end = index)
                    // If 1 point selected (start=end): set end = index (or start if smaller)
                    // If range selected:
                    //   Check if clicking on start or end -> Drag Mode
                    //   Else -> Reset and start new selection? Or expand? 
                    //   UX Request: "Click two points to select range", "Drag start/end points"

                    const indices = draft.selectedChangeIndices.sort((a,b) => a-b);
                    
                    if (indices.length < 2 && (indices.length === 0 || indices[0] !== index)) {
                         // Click to define range or start new
                        if (indices.length === 1) {
                             const start = Math.min(indices[0], index);
                             const end = Math.max(indices[0], index);
                             setRange(start, end);
                        } else {
                            setRange(index, index);
                        }
                    } else {
                        // Check if clicking start or end to drag
                       const start = indices[0];
                       const end = indices[indices.length - 1];
                       
                       if (index === start || index === end) {
                           enableDragNew(index);
                       } else {
                           // Clicking in middle or outside -> Start new selection
                           setRange(index, index);
                       }
                    }
                }
                
                // Better Drag Logic:
                // When drag starts, identify Anchor (the point that stays put).
                // Drag Target is the other point.
                let dragAnchorIndex = -1;

                // Override enableDrag to set Anchor
                function enableDragNew(clickedIndex) {
                     const indices = draft.selectedChangeIndices.sort((a,b) => a-b);
                     const start = indices[0];
                     const end = indices[indices.length - 1];
                     
                     if (start === end) {
                         dragAnchorIndex = -1; // Moving the whole selection (single point)
                     } else if (clickedIndex === start) {
                         dragAnchorIndex = end;
                     } else {
                         dragAnchorIndex = start;
                     }
                     
                     isDragging = true;
                     document.body.style.cursor = 'grabbing';
                     document.addEventListener('mousemove', handleDragMoveNew);
                     document.addEventListener('mouseup', handleDragEndNew);
                }
                
                function handleDragMoveNew(e) {
                     if (!isDragging) return;
                     const rect = timeline.getBoundingClientRect();
                     const x = e.clientX - rect.left - 10; 
                     const effectiveWidth = rect.width - 20;
                     let ratio = x / effectiveWidth;
                     ratio = Math.max(0, Math.min(1, ratio));
                     const total = snapshots.length;
                     const newIndex = Math.round(ratio * (total - 1));
                     
                     if (dragAnchorIndex === -1) {
                         // Moving single point
                         setRange(newIndex, newIndex);
                     } else {
                         const s = Math.min(dragAnchorIndex, newIndex);
                         const e = Math.max(dragAnchorIndex, newIndex);
                         setRange(s, e);
                     }
                }

                function handleDragEndNew() {
                    isDragging = false;
                    document.body.style.cursor = 'default';
                    document.removeEventListener('mousemove', handleDragMoveNew);
                    document.removeEventListener('mouseup', handleDragEndNew);
                }
                
                function setRange(start, end) {
                    const newIndices = [];
                    for (let i = start; i <= end; i++) {
                        newIndices.push(i);
                    }
                    draft.selectedChangeIndices = newIndices;
                    updateSelectionUI();
                    saveDraft();
                }

                // Initialize
                renderTimeline();
            </script>
        </body>
        </html>`;
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

    private static async _loadCss(extensionUri: vscode.Uri): Promise<string> {
        return `
            body { 
                font-family: var(--vscode-font-family);
                padding: 20px;
                color: var(--vscode-editor-foreground);
                background-color: var(--vscode-sideBar-background); /* Match HistoryManager */
            }
            h2, p, label { color: var(--vscode-foreground); }
            button {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 6px 14px;
                cursor: pointer;
                border-radius: 2px;
            }
            button:hover {
                background: var(--vscode-button-hoverBackground);
            }
            .controls {
                margin-bottom: 20px;
                padding: 15px;
                background: var(--vscode-editor-background);
                border: 1px solid var(--vscode-widget-border);
                border-radius: 4px;
            }
            textarea {
                width: 100%;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                padding: 8px;
                border-radius: 2px;
                resize: vertical;
            }
            
            /* Shiki Diff Styling (Matching HistoryManager) */
            .diff-container {
                font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
                font-size: var(--vscode-editor-font-size, 14px);
                line-height: normal;
                background-color: var(--vscode-editor-background);
                border-radius: 4px;
                overflow-x: auto;
                margin-bottom: 10px;
                border: 1px solid var(--vscode-widget-border); /* Add border to container */
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
            
            .diff-added { background-color: var(--vscode-diffEditor-insertedLineBackground, rgba(100, 255, 100, 0.2)); }
            .diff-removed { background-color: var(--vscode-diffEditor-removedLineBackground, rgba(255, 100, 100, 0.2)); }

            /* Timeline Slider */
            .timeline-container {
                position: relative;
                height: 36px; /* Compact height */
                margin: 5px 0; /* Minimal vertical margin */
                padding: 0 10px;
                user-select: none;
            }
            .timeline-track {
                position: absolute;
                top: 50%;
                left: 10px;
                right: 10px;
                height: 4px; /* Thinner track? Or same. 4px is fine. */
                background: var(--vscode-scrollbarSlider-background); /* Softer gray */
                transform: translateY(-50%);
                border-radius: 2px;
            }
            .timeline-range {
                position: absolute;
                top: 50%;
                height: 4px;
                background: var(--vscode-progressBar-background); /* Accent color */
                transform: translateY(-50%);
                z-index: 1;
                opacity: 1;
            }
            .timeline-dot {
                position: absolute;
                top: 50%;
                width: 6px; /* Smaller */
                height: 6px; /* Smaller */
                background: var(--vscode-editor-background); /* Initial state: hollow-ish */
                border: 2px solid var(--vscode-progressBar-background);
                border-radius: 50%;
                transform: translate(-50%, -50%);
                cursor: pointer;
                z-index: 2;
                transition: transform 0.1s, background-color 0.1s, border-color 0.1s;
            }
            .timeline-dot:hover {
                transform: translate(-50%, -50%) scale(1.3);
                background: var(--vscode-progressBar-background); /* Filled on hover */
                border-color: var(--vscode-progressBar-background);
                z-index: 20; 
            }
            .timeline-dot.active {
                background: var(--vscode-progressBar-background); /* Filled when active (start/end) */
                border-color: var(--vscode-progressBar-background);
                z-index: 3;
                transform: translate(-50%, -50%) scale(1.2); /* Slightly larger */
            }
            .timeline-dot.in-range {
                background: var(--vscode-progressBar-background); /* Filled in range */
                border-color: var(--vscode-progressBar-background);
            }
            
            /* Tooltip */
            .timeline-tooltip {
                position: absolute;
                background: var(--vscode-editorHoverWidget-background);
                border: 1px solid var(--vscode-editorHoverWidget-border);
                color: var(--vscode-editorHoverWidget-foreground);
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 11px;
                pointer-events: none;
                white-space: nowrap;
                z-index: 10;
                top: -30px;
                transform: translateX(-50%);
                opacity: 0;
                transition: opacity 0.1s;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            }
            .timeline-dot:hover .timeline-tooltip {
                opacity: 1;
            }

            /* History Entry Styling */
            .diff-selection-root {
                margin-bottom: 30px;
                background-color: var(--vscode-editor-background);
                border: 1px solid var(--vscode-widget-border);
                border-radius: 6px;
                overflow: hidden;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
            }
            .diff-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px 12px;
                background-color: var(--vscode-editor-inactiveSelectionBackground);
                border-bottom: 1px solid var(--vscode-widget-border);
            }
            .diff-meta {
                font-size: 13px;
                font-weight: 600;
                color: var(--vscode-foreground);
            }
            .diff-actions {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .icon-btn {
                background: none;
                border: none;
                color: var(--vscode-icon-foreground);
                cursor: pointer;
                padding: 4px;
                border-radius: 3px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .icon-btn:hover {
                background-color: var(--vscode-toolbar-hoverBackground);
            }
            .codicon-comment-flipped {
                transform: scaleX(-1);
            }
            
            .comment-area {
                padding: 10px;
                background-color: var(--vscode-editor-background);
                border-top: 1px solid var(--vscode-widget-border);
                border: 1px solid var(--vscode-input-border);
                border-radius: 2px;
                padding: 4px;
                font-family: var(--vscode-font-family);
                resize: vertical;
            }
            .toggle-comment-btn {
                background: none;
                border: none;
                color: var(--vscode-textLink-foreground);
                cursor: pointer;
                padding: 0;
                font-size: 0.9em;
                text-align: left;
                width: fit-content;
            }
            .toggle-comment-btn:hover {
                text-decoration: underline;
            }

            pre.shiki { margin: 0; padding: 0; background-color: transparent !important; }
            .shiki code { background-color: transparent !important; }
        `;
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
