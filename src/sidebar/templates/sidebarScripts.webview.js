const vscode = acquireVsCodeApi();

const rootDisplay = document.getElementById('root-folder-display');
const recordingToggle = document.getElementById('recording-toggle');
const recordingStatusText = document.getElementById('recording-status-text');
const langStatusText = document.getElementById('lang-status-text');
const langChips = document.querySelectorAll('.lang-chip');
const logsContainer = document.getElementById('logs-container');
const fullLogsContainer = document.getElementById('full-logs-container');
const blogLogsContainer = document.getElementById('blog-logs-container');
const mainView = document.getElementById('main-view');
const fullLogsView = document.getElementById('full-logs-view');
const blogLogSelectionView = document.getElementById('blog-log-selection-view');

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

function renderLogs(logs, container = logsContainer, isBlogSelection = false) {
    const targetContainer = container;
    const logData = logs || [];

    if (!logData || logData.length === 0) {
        targetContainer.innerHTML = '<div class="empty-logs">기록된 변경 사항이 없습니다.</div>';
        return;
    }

    targetContainer.innerHTML = '';
    logData.forEach((log) => {
        const item = document.createElement('div');
        item.className = 'log-item';
        // Store full log data on element
        item.dataset.log = JSON.stringify(log);

        item.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isBlogSelection) {
                vscode.postMessage({ type: 'selectLogForBlog', path: log.filePath });
            } else {
                showContextMenu(e.clientX, e.clientY, log);
            }
        };

        const info = document.createElement('div');
        info.className = 'log-info';

        const name = document.createElement('div');
        name.className = 'log-name';
        name.innerText = log.fileName;

        const meta = document.createElement('div');
        meta.className = 'log-meta';
        meta.setAttribute('data-language', log.language);
        meta.setAttribute('data-timestamp', log.lastModified);
        meta.innerText = `${log.language} • ${timeAgo(log.lastModified)}`;

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
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
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
    metas.forEach((meta) => {
        const timestamp = parseInt(meta.getAttribute('data-timestamp') || '0');
        const language = meta.getAttribute('data-language') || '';
        if (timestamp > 0) {
            meta.innerText = `${language} • ${timeAgo(timestamp)}`;
        }
    });

    const nextTick = 1000 - (Date.now() % 1000);
    setTimeout(updateRelativeTimes, nextTick);
}

updateRelativeTimes();

window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
        case 'updateState':
            rootDisplay.textContent = message.root || '전체 워크스페이스';
            recordingToggle.checked = message.isRecording;
            recordingStatusText.textContent = message.isRecording ? '실시간 기록 중' : '중지됨';
            recordingStatusText.style.color = message.isRecording
                ? 'var(--vscode-charts-green)'
                : 'inherit';

            langChips.forEach((chip) => {
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
                .map((l) => '.' + l)
                .join(', ');
            langStatusText.textContent = enabledLangs ? `(현재: ${enabledLangs})` : '(선택 없음)';

            if (message.recentLogs) {
                renderLogs(message.recentLogs);
            }

            if (message.totalLogSize) {
                const manageBtnSpan = document.querySelector('#manage-logs-btn span:last-child');
                if (manageBtnSpan) {
                    manageBtnSpan.textContent = `전체 로그 관리 (${message.totalLogSize})`;
                }
            }
            break;
        case 'showFullLogs':
            mainView.classList.add('hidden');
            fullLogsView.classList.remove('hidden');
            blogLogSelectionView.classList.add('hidden');
            // Render into fullLogsContainer
            renderLogs(message.logs, fullLogsContainer);
            break;
        case 'showBlogSelectionLogs':
            mainView.classList.add('hidden');
            fullLogsView.classList.add('hidden');
            blogLogSelectionView.classList.remove('hidden');
            // Render into blogLogsContainer with clickable action
            renderLogs(message.logs, blogLogsContainer, true);
            break;
    }
});

recordingToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleRecording' });
});

langChips.forEach((chip) => {
    chip.addEventListener('click', () => {
        vscode.postMessage({
            type: 'toggleLanguage',
            value: chip.getAttribute('data-lang'),
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

document.getElementById('blog-logs-back-btn').addEventListener('click', () => {
    blogLogSelectionView.classList.add('hidden');
    mainView.classList.remove('hidden');
});

// 초기 데이터 요청
vscode.postMessage({ type: 'getInitialData' });
