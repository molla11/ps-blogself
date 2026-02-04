import * as vscode from 'vscode';

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

    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>PS-Blogself</title>
                <link href="${codiconsUri}" rel="stylesheet" />
                <style>
                    :root {
                        --container-padding: 10px;
                        --border-radius: 4px;
                        --item-margin: 8px;
                    }

                    body {
                        padding: var(--container-padding);
                        color: var(--vscode-foreground);
                        font-family: var(--vscode-font-family);
                        font-size: var(--vscode-font-size);
                        line-height: 1.3;
                        background-color: var(--vscode-sideBar-background);
                        display: flex;
                        flex-direction: column;
                        height: 100vh;
                        box-sizing: border-box;
                        overflow: hidden;
                    }

                    /* Utility */
                    .flex-shrink-0 { flex-shrink: 0; }
                    .flex-grow-1 { flex-grow: 1; }
                    
                    /* Config Sections (Top) */
                    .config-section {
                        flex-shrink: 0;
                    }

                    .config-box {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        background: var(--vscode-editor-background);
                        padding: 8px 10px;
                        border-radius: var(--border-radius);
                        border: 1px solid var(--vscode-widget-border);
                        margin-bottom: var(--item-margin);
                    }

                    .config-box.vertical {
                        flex-direction: column;
                        align-items: flex-start;
                        gap: 8px;
                    }

                    .config-info {
                        display: flex;
                        flex-direction: column;
                        gap: 2px;
                    }

                    .config-title {
                        font-weight: 700;
                        font-size: 0.75rem;
                        opacity: 0.9;
                    }

                    .config-subtitle {
                        font-size: 0.8rem;
                        opacity: 0.6;
                    }

                    /* Toggle Switch */
                    .switch {
                        position: relative;
                        display: inline-block;
                        width: 30px;
                        height: 16px;
                    }

                    .switch input { opacity: 0; width: 0; height: 0; }

                    .slider {
                        position: absolute;
                        cursor: pointer;
                        top: 0; left: 0; right: 0; bottom: 0;
                        background-color: #ccc;
                        transition: .2s;
                        border-radius: 16px;
                    }

                    .slider:before {
                        position: absolute;
                        content: "";
                        height: 12px; width: 12px;
                        left: 2px; bottom: 2px;
                        background-color: white;
                        transition: .2s;
                        border-radius: 50%;
                    }

                    input:checked + .slider { background-color: var(--vscode-button-background); }
                    input:checked + .slider:before { transform: translateX(14px); }

                    /* Language Chips */
                    .language-group { display: flex; gap: 4px; }

                    .lang-chip {
                        padding: 2px 8px;
                        border-radius: 10px;
                        font-size: 0.7rem;
                        font-weight: 600;
                        cursor: pointer;
                        border: 1px solid var(--vscode-widget-border);
                        background: var(--vscode-sideBar-background);
                        opacity: 0.5;
                        transition: all 0.1s;
                    }

                    .lang-chip.active {
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border-color: transparent;
                        opacity: 1;
                    }

                    /* Path status */
                    .current-status {
                        padding: 8px 10px;
                        background: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-widget-border);
                        border-radius: var(--border-radius);
                        margin-bottom: var(--item-margin);
                    }

                    .status-title {
                        font-size: 0.65rem;
                        font-weight: 700;
                        margin-bottom: 4px;
                        opacity: 0.5;
                    }

                    .status-value {
                        margin-top: 3px;
                        word-break: break-all;
                        font-family: var(--vscode-editor-font-family);
                        font-size: 0.7rem;
                        padding: 4px 6px;
                        background: var(--vscode-textBlockQuote-background);
                        border-radius: 3px;
                        border: 1px solid var(--vscode-textBlockQuote-border);
                        margin-left: 0;
                    }

                    .current-status .button-group {
                        margin-top: 10px;
                        margin-bottom: 0;
                    }

                    /* Button Group */
                    .button-group {
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                    }

                    button {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        width: 100%;
                        padding: 4px 8px;
                        cursor: pointer;
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        border-radius: 3px;
                        font-weight: 600;
                        font-size: 0.75rem;
                        height: 24px;
                        transition: filter 0.1s;
                    }

                    button:hover { filter: brightness(1.1); }

                    .secondary {
                        background-color: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                    }
                    
                    button.action-btn {
                        height: 28px;
                        font-size: 0.8rem;
                    }

                    .icon { font-size: 0.9rem; flex-shrink: 0; }

                    .hint {
                        margin-top: 4px;
                        margin-bottom: 8px;
                        font-size: 0.65rem;
                        opacity: 0.7;
                        display: flex;
                        gap: 4px;
                    }

                    /* Recent Logs Section (Middle) */
                    .logs-section {
                        flex-grow: 1;
                        overflow-y: auto;
                        margin-bottom: var(--item-margin);
                        border-top: 1px solid var(--vscode-widget-border);
                        border-bottom: 1px solid var(--vscode-widget-border);
                        padding: 8px 0;
                    }

                    .logs-title {
                        font-size: 0.7rem;
                        font-weight: 700;
                        opacity: 0.7;
                        margin-bottom: 8px;
                        padding: 0 4px;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }

                    .logs-container {
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                    }
                    
                    .log-item {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        padding: 6px 8px;
                        background: var(--vscode-list-hoverBackground);
                        border-radius: 3px;
                        cursor: pointer;
                        transition: background 0.1s;
                    }

                    .log-item:hover {
                        background: var(--vscode-list-activeSelectionBackground);
                        color: var(--vscode-list-activeSelectionForeground);
                    }

                    .log-info {
                        display: flex;
                        flex-direction: column;
                        overflow: hidden;
                    }

                    .log-name {
                        font-size: 0.75rem;
                        font-weight: 600;
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                    }

                    .log-meta {
                        font-size: 0.65rem;
                        opacity: 0.7;
                        display: flex;
                        gap: 6px;
                    }

                    .empty-logs {
                        font-size: 0.7rem;
                        opacity: 0.5;
                        text-align: center;
                        padding: 20px 0;
                    }

                    /* Bottom Actions */
                    .bottom-actions {
                        flex-shrink: 0;
                        display: flex;
                        flex-direction: column;
                        gap: 6px;
                    }

                    /* Context Menu */
                    #context-menu {
                        display: none;
                        position: absolute;
                        z-index: 1000;
                        background: var(--vscode-menu-background);
                        border: 1px solid var(--vscode-menu-border);
                        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
                        border-radius: 4px;
                        padding: 4px 0;
                        min-width: 120px;
                    }

                    #context-menu.visible {
                        display: block;
                    }

                    .menu-item {
                        padding: 6px 12px;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        font-size: 11px;
                        color: var(--vscode-menu-foreground);
                    }

                    .menu-item:hover {
                        background: var(--vscode-menu-selectionBackground);
                        color: var(--vscode-menu-selectionForeground);
                    }

                    /* View Switching */
                    .view-container {
                        display: flex;
                        flex-direction: column;
                        height: 100%;
                        width: 100%;
                    }

                    .hidden {
                        display: none !important;
                    }

                    .header-bar {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        margin-bottom: 10px;
                        padding-bottom: 8px;
                        border-bottom: 1px solid var(--vscode-widget-border);
                    }

                    .header-title {
                        font-weight: 700;
                        font-size: 0.8rem;
                        white-space: nowrap;
                    }

                    .back-btn {
                        width: auto;
                        padding: 4px;
                        background: none;
                        border: none;
                        color: var(--vscode-foreground);
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        border-radius: 3px;
                    }

                    .back-btn:hover {
                        background: var(--vscode-toolbar-hoverBackground);
                    }
                </style>
			</head>
			<body>
                <div id="main-view" class="view-container">
                    <div class="config-section">
                        <div class="config-box">
                            <div class="config-info">
                                <span class="config-title">기록 상태</span>
                                <span id="recording-status-text" class="config-subtitle">대기 중</span>
                            </div>
                            <label class="switch">
                                <input type="checkbox" id="recording-toggle">
                                <span class="slider"></span>
                            </label>
                        </div>

                        <div class="config-box vertical">
                            <div class="config-info">
                                <span class="config-title">대상 확장자</span>
                                <span id="lang-status-text" class="config-subtitle">현재: .c, .cpp, .py</span>
                            </div>
                            <div class="language-group">
                                <div class="lang-chip" data-lang="c">C</div>
                                <div class="lang-chip" data-lang="cpp">C++</div>
                                <div class="lang-chip" data-lang="py">Python</div>
                            </div>
                        </div>

                        <div class="current-status">
                            <span class="config-title">활성 경로</span>
                            <div id="root-folder-display" class="status-value">로딩 중...</div>
                            

                            <div class="hint">
                                <span>활성 경로 하위, 대상 확장자의 파일 수정만을 기록합니다.</span>
                            </div>

                            <div class="status-title" style="margin-top: 12px;">활성 경로 편집</div>
                            <div class="button-group">
                                <button id="clear-folder-btn" class="secondary">
                                    <span class="icon"> 🌐 </span>
                                    <span>전체 디렉토리</span>
                                </button>
                                <button id="use-ws-root-btn" class="secondary">
                                    <span class="icon"> 📂 </span>
                                    <span>현재 디렉토리</span>
                                </button>
                                <button id="select-folder-btn" class="secondary">
                                    <span class="icon"> 🖱️ </span>
                                    <span>사용자 지정 디렉토리</span>
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- Recent Logs Section -->
                    <div class="logs-section">
                        <div class="logs-title">
                            <span>최근 변경 기록 (상위 20개)</span>
                            <!-- <span style="font-size: 0.65rem; opacity: 0.5;">Auto-scroll</span> -->
                        </div>
                        <div id="logs-container" class="logs-container">
                            <div class="empty-logs">기록된 변경 사항이 없습니다.</div>
                        </div>
                    </div>

                    <!-- Bottom Actions -->
                    <div class="bottom-actions">
                        <button id="manage-logs-btn" class="action-btn secondary">
                            <span class="icon">📜</span>
                            <span>전체 로그 관리</span>
                        </button>
                        <button id="generate-blog-btn" class="action-btn">
                            <span class="icon">✨</span>
                            <span>블로그 포스트 생성</span>
                        </button>
                    </div>
                </div>

                <!-- Full Logs View -->
                <div id="full-logs-view" class="view-container hidden">
                    <div class="header-bar">
                        <button id="full-logs-back-btn" class="back-btn" title="Back">
                            <i class="codicon codicon-arrow-left"></i>
                        </button>
                        <span class="header-title">전체 코드 기록 관리</span>
                    </div>
                    <div class="logs-section">
                         <div id="full-logs-container" class="logs-container">
                            <!-- Logs here -->
                        </div>
                    </div>
                </div>

                <!-- Context Menu Template -->
                <div id="context-menu">
                    <div class="menu-item" id="ctx-open-file">
                         파일 열기
                    </div>
                    <div class="menu-item" id="ctx-view-history">
                        수정 기록 보기
                    </div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();

                    const rootDisplay = document.getElementById('root-folder-display');
                    const recordingToggle = document.getElementById('recording-toggle');
                    const recordingStatusText = document.getElementById('recording-status-text');
                    const langStatusText = document.getElementById('lang-status-text');
                    const langChips = document.querySelectorAll('.lang-chip');
                    const logsContainer = document.getElementById('logs-container');
                    const fullLogsContainer = document.getElementById('full-logs-container');
                    const mainView = document.getElementById('main-view');
                    const fullLogsView = document.getElementById('full-logs-view');

                    const rtf = new Intl.RelativeTimeFormat('ko', { numeric: 'auto' });

                    function timeAgo(timestamp) {
                        const seconds = Math.floor((Date.now() - timestamp) / 1000);
                        if (seconds < 60) return rtf.format(-seconds, 'second');
                        const minutes = Math.floor(seconds / 60);
                        if (minutes < 60) return rtf.format(-minutes, 'minute');
                        const hours = Math.floor(minutes / 60);
                        if (hours < 24) return rtf.format(-hours, 'hour');
                        const days = Math.floor(hours / 24);
                        return rtf.format(-days, 'day');
                    }

                    // Store logs globally to re-render
                    let currentLogs = [];

                    function renderLogs(logs, container = logsContainer) {
                        const targetContainer = container;
                        const logData = logs || [];
                        
                        if (!logData || logData.length === 0) {
                            targetContainer.innerHTML = '<div class="empty-logs">기록된 변경 사항이 없습니다.</div>';
                            return;
                        }

                        targetContainer.innerHTML = '';
                        logData.forEach(log => {
                            const item = document.createElement('div');
                            item.className = 'log-item';
                            // Store full log data on element
                            item.dataset.log = JSON.stringify(log);
                            
                            item.onclick = (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                showContextMenu(e.clientX, e.clientY, log);
                            };

                            const info = document.createElement('div');
                            info.className = 'log-info';

                            const name = document.createElement('div');
                            name.className = 'log-name';
                            name.innerText = log.fileName;

                            const meta = document.createElement('div');
                            meta.className = 'log-meta';
                            meta.setAttribute('data-language', log.language);
                            meta.innerText = \`\${log.language} • \${timeAgo(log.lastModified)}\`;

                            info.appendChild(name);
                            info.appendChild(meta);
                            item.appendChild(info);
                            
                            targetContainer.appendChild(item);
                        });
                    }

                    // Context Menu Logic
                    const contextMenu = document.getElementById('context-menu');
                    let selectedLog = null;

                    function showContextMenu(x, y, log) {
                        selectedLog = log;
                        contextMenu.style.left = \`\${x}px\`;
                        contextMenu.style.top = \`\${y}px\`;
                        contextMenu.classList.add('visible');
                    }

                    function hideContextMenu() {
                        contextMenu.classList.remove('visible');
                        selectedLog = null;
                    }

                    // Global click to close menu
                    document.addEventListener('click', () => {
                        hideContextMenu();
                    });

                    // Context menu actions
                    document.getElementById('ctx-open-file').addEventListener('click', () => {
                        if (selectedLog) {
                            vscode.postMessage({ type: 'openFile', path: selectedLog.filePath });
                        }
                    });

                    document.getElementById('ctx-view-history').addEventListener('click', () => {
                        if (selectedLog) {
                            vscode.postMessage({ type: 'viewHistory', path: selectedLog.filePath });
                        }
                    });

                    function updateRelativeTimes() {
                        const metas = document.querySelectorAll('.log-meta');
                        metas.forEach(meta => {
                            const timestamp = parseInt(meta.getAttribute('data-timestamp') || '0');
                            const language = meta.getAttribute('data-language') || '';
                            if (timestamp > 0) {
                                meta.innerText = \`\${language} • \${timeAgo(timestamp)}\`;
                            }
                        });

                        const nextTick = 1000 - (Date.now() % 1000);
                        setTimeout(updateRelativeTimes, nextTick);
                    }

                    updateRelativeTimes();

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'updateState':
                                rootDisplay.textContent = message.root || '전체 워크스페이스';
                                recordingToggle.checked = message.isRecording;
                                recordingStatusText.textContent = message.isRecording ? '실시간 기록 중' : '중지됨';
                                recordingStatusText.style.color = message.isRecording ? 'var(--vscode-charts-green)' : 'inherit';
                                
                                langChips.forEach(chip => {
                                    const lang = chip.getAttribute('data-lang');
                                    if (message.languages.includes(lang)) {
                                        chip.classList.add('active');
                                    } else {
                                        chip.classList.remove('active');
                                    }
                                });

                                const order = ['c', 'cpp', 'py'];
                                const enabledLangs = message.languages
                                    .slice()
                                    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
                                    .map(l => '.' + l)
                                    .join(', ');
                                langStatusText.textContent = enabledLangs ? \`(현재: \${enabledLangs})\` : '(필터링 없음)';

                                if (message.recentLogs) {
                                    renderLogs(message.recentLogs);
                                }

                                if (message.totalLogSize) {
                                    const manageBtnSpan = document.querySelector('#manage-logs-btn span:last-child');
                                    if (manageBtnSpan) {
                                        manageBtnSpan.textContent = \`전체 로그 관리 (\${message.totalLogSize})\`;
                                    }
                                }
                                break;
                            case 'showFullLogs':
                                mainView.classList.add('hidden');
                                fullLogsView.classList.remove('hidden');
                                // Render into fullLogsContainer
                                renderLogs(message.logs, fullLogsContainer);
                                break;
                        }
                    });

                    recordingToggle.addEventListener('change', () => {
                        vscode.postMessage({ type: 'toggleRecording' });
                    });

                    langChips.forEach(chip => {
                        chip.addEventListener('click', () => {
                            vscode.postMessage({ 
                                type: 'toggleLanguage', 
                                value: chip.getAttribute('data-lang') 
                            });
                        });
                    });

                    document.getElementById('use-ws-root-btn').addEventListener('click', () => {
                        vscode.postMessage({ type: 'useWorkspaceRoot' });
                    });

                    document.getElementById('select-folder-btn').addEventListener('click', () => {
                        vscode.postMessage({ type: 'selectRootFolder' });
                    });

                    document.getElementById('clear-folder-btn').addEventListener('click', () => {
                        vscode.postMessage({ type: 'clearRootFolder' });
                    });

                    document.getElementById('generate-blog-btn').addEventListener('click', () => {
                        vscode.postMessage({ type: 'generateBlog' });
                    });

                    document.getElementById('manage-logs-btn').addEventListener('click', () => {
                        vscode.postMessage({ type: 'manageLogs' });
                    });
                    
                    document.getElementById('full-logs-back-btn').addEventListener('click', () => {
                        fullLogsView.classList.add('hidden');
                        mainView.classList.remove('hidden');
                        // Optionally refresh main state?
                        // vscode.postMessage({ type: 'getInitialData' }); 
                    });

                    // 초기 데이터 요청
                    vscode.postMessage({ type: 'getInitialData' });
                </script>
			</body>
			</html>`;
}
