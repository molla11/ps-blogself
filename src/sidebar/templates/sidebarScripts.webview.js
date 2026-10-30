const vscode = acquireVsCodeApi();

const rootDisplay = document.getElementById('root-folder-display');
const rootButton = document.getElementById('root-folder-btn');
const rootHint = document.getElementById('root-folder-hint');
const resetRootButton = document.getElementById('clear-folder-btn');
const pathMenu = document.getElementById('path-menu');
const currentDirectoryButton = document.getElementById('use-ws-root-btn');
const currentDirectoryLabel = document.getElementById('current-directory-label');
const recordingToggle = document.getElementById('recording-toggle');
const recordingStatusText = document.getElementById('recording-status-text');
const langStatusText = document.getElementById('lang-status-text');
const langChips = document.querySelectorAll('.lang-chip');
const logsContainer = document.getElementById('logs-container');
const fullLogsContainer = document.getElementById('full-logs-container');
const mainView = document.getElementById('main-view');
const fullLogsView = document.getElementById('full-logs-view');
const recentLogsLoader = document.getElementById('recent-logs-loader');
const recentLogsStatus = document.getElementById('recent-logs-status');
const retryLogsButton = document.getElementById('retry-logs-btn');
const logsSearchToggle = document.getElementById('toggle-logs-search-btn');
const logsSearch = document.getElementById('logs-search');
const logsSearchInput = document.getElementById('logs-search-input');

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
let recentLogsRevision = -1;
let hasMoreRecentLogs = false;
let recentLogsRequestId = 0;
let pendingRecentLogsRequest = null;
let recentLogsError = '';
let recentLogsCheckScheduled = false;
let recentLogsSearchId = 0;
let recentLogsQuery = '';
let recentLogsNeedsSearch = false;
let recentLogsSearchTimer;
let recentLogsComposing = false;
let recentLogsAutoLoad = true;
let selectedPath = vscode.getState()?.selectedPath || '';
function selectPath(filePath) {
    selectedPath = filePath;
    vscode.setState({ selectedPath });
    document.querySelectorAll('.log-item').forEach((item) => {
        const selected = item.dataset.path === selectedPath;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-pressed', String(selected));
    });
}

// File selection and the temporary action menu have independent state.
// All rows share this controller, including rows in the full history view.
class FileActionsMenu {
    constructor(element) {
        this.element = element;
        this.owner = null;
        this.point = null;
        this.items = [...element.querySelectorAll('[role="menuitem"]')];
    }

    get isOpen() { return this.owner !== null; }

    open(row, { point = null, focus = false, last = false } = {}) {
        this.close();
        this.owner = row;
        this.point = point;
        row.setAttribute('aria-expanded', 'true');
        this.element.setAttribute('aria-label', row.dataset.name + ' 작업');
        this.element.hidden = false;
        this.position();
        if (focus) (last ? this.items.at(-1) : this.items[0]).focus();
    }

    close(restoreFocus = false) {
        const row = this.owner;
        this.owner = null;
        this.point = null;
        this.element.hidden = true;
        row?.setAttribute('aria-expanded', 'false');
        if (restoreFocus && row?.isConnected) row.focus({ preventScroll: true });
    }

    position() {
        if (!this.owner) return;
        if (!this.owner.isConnected) { this.close(); return; }
        const row = this.owner.getBoundingClientRect();
        const list = this.owner.closest('.logs-container').getBoundingClientRect();
        if (row.bottom <= list.top || row.top >= list.bottom) { this.close(); return; }
        const menu = this.element.getBoundingClientRect();
        const width = document.documentElement.clientWidth;
        const height = document.documentElement.clientHeight;
        const gap = 6;
        // Pointer menus follow the click; keyboard menus stay anchored to the row.
        const left = this.point ? this.point.x + gap : row.left;
        const below = (this.point?.y ?? row.bottom) + gap;
        const above = (this.point?.y ?? row.top) - gap - menu.height;
        // Flip above when needed, keeping the click point clear for a double-click.
        // Prefer the list area so the menu does not cover the footer controls.
        const top = below + menu.height <= Math.min(list.bottom, height) ? below
            : above >= Math.max(list.top, 0) ? above
            : below + menu.height <= height ? below : above;
        // Measure the rendered menu instead of assuming a fixed label size.
        this.element.style.left = Math.max(0, Math.min(left, width - menu.width)) + 'px';
        this.element.style.top = Math.max(0, Math.min(top, height - menu.height)) + 'px';
    }

    activate(action) {
        const filePath = this.owner?.dataset.path;
        this.close(true);
        if (filePath) vscode.postMessage({ type: action, path: filePath });
    }

    navigate(key) {
        const current = this.items.indexOf(document.activeElement);
        const index = key === 'Home' ? 0 : key === 'End' ? this.items.length - 1
            : (current + (key === 'ArrowDown' ? 1 : -1) + this.items.length) % this.items.length;
        this.items[index].focus();
    }
}

const fileActions = new FileActionsMenu(document.getElementById('context-menu'));

function closePathMenu(restoreFocus = false) {
    pathMenu.hidden = true;
    rootButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus) rootButton.focus({ preventScroll: true });
}

function openPathMenu(focus = false, last = false) {
    fileActions.close();
    pathMenu.hidden = false;
    rootButton.setAttribute('aria-expanded', 'true');
    if (focus) {
        const items = pathMenu.querySelectorAll('[role="menuitem"]:not(:disabled)');
        (last ? items[items.length - 1] : items[0]).focus();
    }
}

function updateCurrentDirectory(directory) {
    const suffix = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
    const label = directory ? directory + (/[\\/]$/.test(directory) ? '' : suffix) : '열린 작업 폴더 없음';
    currentDirectoryLabel.textContent = label;
    currentDirectoryButton.dataset.path = directory;
    currentDirectoryButton.disabled = !directory;
    currentDirectoryButton.title = directory ? label + '로 설정' : label;
    currentDirectoryButton.setAttribute('aria-label', currentDirectoryButton.title);
    currentDirectoryButton.querySelector('.path-suffix').hidden = !directory;
}

function closeMenus() {
    fileActions.close();
    closePathMenu();
}

function renderLogs(logs, container = logsContainer) {
    const rows = new Map([...container.querySelectorAll('.log-item')].map(row => [row.dataset.path, row]));
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    const top = container.getBoundingClientRect().top;
    const anchor = container.scrollTop > 0
        ? [...rows.values()].find(row => row.getBoundingClientRect().bottom > top) : null;
    const anchorTop = anchor?.getBoundingClientRect().top;
    const tail = container === logsContainer ? recentLogsLoader : null;
    const nextRows = (logs || []).map(log => {
        let row = rows.get(log.filePath);
        if (!row) {
            row = document.createElement('button');
            row.type = 'button';
            row.className = 'log-item';
            row.dataset.path = log.filePath;
            row.setAttribute('aria-haspopup', 'menu');
            row.setAttribute('aria-controls', 'context-menu');
            row.setAttribute('aria-expanded', 'false');
            row.setAttribute('aria-description', '클릭하면 작업을 선택합니다. 더블클릭하면 파일을 엽니다.');
            const info = document.createElement('span');
            info.className = 'log-info';
            const name = document.createElement('span');
            name.className = 'log-name';
            const meta = document.createElement('span');
            meta.className = 'log-meta';
            info.append(name, meta);
            row.append(info);
        }
        row.dataset.name = log.fileName;
        row.title = log.filePath;
        row.classList.toggle('selected', log.filePath === selectedPath);
        row.setAttribute('aria-pressed', String(log.filePath === selectedPath));
        row.querySelector('.log-name').textContent = log.fileName;
        const meta = row.querySelector('.log-meta');
        meta.dataset.language = log.language;
        meta.dataset.timestamp = log.lastModified;
        meta.textContent = `${log.language} • ${timeAgo(log.lastModified)}`;
        return row;
    });

    const retained = new Set(nextRows);
    for (const child of [...container.children]) {
        if (child !== tail && !retained.has(child)) {
            if (fileActions.owner === child) fileActions.close();
            child.remove();
        }
    }
    // Preserve row identity, focus and native double-clicks during background updates.
    let cursor = container.firstElementChild;
    for (const row of nextRows) {
        if (row !== cursor) container.insertBefore(row, cursor);
        cursor = row.nextElementSibling;
    }
    if (!nextRows.length && !(container === logsContainer && recentLogsNeedsSearch)) {
        const empty = document.createElement('div');
        empty.className = 'empty-logs';
        empty.setAttribute('role', 'status');
        empty.textContent = container === logsContainer && recentLogsQuery ? '검색 결과가 없습니다.' : '기록된 변경 사항이 없습니다.';
        container.insertBefore(empty, tail);
    }
    if (anchor?.isConnected) container.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    fileActions.position();
}

function updateRecentLogsStatus() {
    const loading = pendingRecentLogsRequest !== null || (recentLogsNeedsSearch && !recentLogsError);
    logsContainer.setAttribute('aria-busy', String(loading));
    recentLogsLoader.hidden = !hasMoreRecentLogs && !loading && !recentLogsError;
    recentLogsStatus.textContent = recentLogsError || (loading ? (recentLogsQuery ? '검색 중…' : '기록을 불러오는 중…') : '');
    retryLogsButton.hidden = !recentLogsError;
    document.getElementById('generate-blog-btn').disabled = !currentLogs.length;
}

function requestMoreRecentLogs() {
    if (recentLogsNeedsSearch || !hasMoreRecentLogs || pendingRecentLogsRequest !== null) return;
    recentLogsError = '';
    pendingRecentLogsRequest = ++recentLogsRequestId;
    updateRecentLogsStatus();
    vscode.postMessage({ type: 'loadMoreLogs', requestId: pendingRecentLogsRequest, count: currentLogs.length, searchId: recentLogsSearchId });
}

function checkRecentLogsEnd() {
    if (recentLogsCheckScheduled) return;
    recentLogsCheckScheduled = true;
    requestAnimationFrame(() => {
        recentLogsCheckScheduled = false;
        if (!recentLogsAutoLoad || mainView.classList.contains('hidden') || !logsContainer.clientHeight || recentLogsError) return;
        // Prefetch about two rows before the end, including after a viewport resize.
        if (logsContainer.scrollHeight - logsContainer.scrollTop - logsContainer.clientHeight <= 120) requestMoreRecentLogs();
    });
}

function applyRecentLogs(message) {
    if ((message.recentLogsSearchId ?? 0) !== recentLogsSearchId) return;
    if (typeof message.recentLogsRevision === 'number') {
        if (message.recentLogsRevision <= recentLogsRevision) return;
        recentLogsRevision = message.recentLogsRevision;
    }
    currentLogs = message.recentLogs;
    recentLogsNeedsSearch = false;
    hasMoreRecentLogs = Boolean(message.hasMoreRecentLogs);
    recentLogsError = '';
    if (!currentLogs.some(log => log.filePath === selectedPath)) {
        selectPath(currentLogs.find(log => log.filePath === message.activeFile)?.filePath || currentLogs[0]?.filePath || '');
    }
    renderLogs(currentLogs);
    updateRecentLogsStatus();
    checkRecentLogsEnd();
}

function requestLogsSearch() {
    clearTimeout(recentLogsSearchTimer);
    if (!recentLogsNeedsSearch || pendingRecentLogsRequest !== null || recentLogsComposing) return;
    recentLogsError = '';
    pendingRecentLogsRequest = ++recentLogsRequestId;
    updateRecentLogsStatus();
    vscode.postMessage({ type: 'searchLogs', requestId: pendingRecentLogsRequest, searchId: recentLogsSearchId, query: recentLogsQuery });
}

function updateLogsSearch() {
    clearTimeout(recentLogsSearchTimer);
    const query = logsSearchInput.value.trim();
    if (query !== recentLogsQuery) {
        recentLogsQuery = query;
        recentLogsSearchId++;
        recentLogsRevision = -1;
        pendingRecentLogsRequest = null;
        recentLogsNeedsSearch = true;
        recentLogsError = '';
        hasMoreRecentLogs = false;
        currentLogs = [];
        // Clearing starts at 20 again; expand only after another scroll gesture.
        recentLogsAutoLoad = Boolean(query);
        fileActions.close();
        logsContainer.scrollTop = 0;
        renderLogs([]);
        updateRecentLogsStatus();
    }
    if (!recentLogsNeedsSearch || recentLogsComposing) return;
    if (!query) requestLogsSearch();
    else recentLogsSearchTimer = setTimeout(requestLogsSearch, 150);
}

function setLogsSearchOpen(open) {
    logsSearch.hidden = !open;
    logsSearchToggle.setAttribute('aria-expanded', String(open));
    if (open) logsSearchInput.focus();
    else {
        recentLogsComposing = false;
        logsSearchInput.value = '';
        updateLogsSearch();
        logsSearchToggle.focus();
    }
}

logsSearchToggle.addEventListener('click', () => setLogsSearchOpen(logsSearch.hidden));
logsSearchInput.addEventListener('input', updateLogsSearch);
logsSearchInput.addEventListener('compositionstart', () => {
    recentLogsComposing = true;
    clearTimeout(recentLogsSearchTimer);
});
logsSearchInput.addEventListener('compositionend', () => {
    recentLogsComposing = false;
    updateLogsSearch();
});
logsSearchInput.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); setLogsSearchOpen(false); }
    if (event.key === 'Enter') { event.preventDefault(); requestLogsSearch(); }
});

logsContainer.addEventListener('scroll', () => {
    if (logsContainer.scrollTop > 0) recentLogsAutoLoad = true;
    checkRecentLogsEnd();
});
logsContainer.addEventListener('wheel', event => {
    if (event.deltaY > 0) { recentLogsAutoLoad = true; checkRecentLogsEnd(); }
}, { passive: true });
logsContainer.addEventListener('keydown', event => {
    if (['PageDown', 'End', 'ArrowDown', ' '].includes(event.key)) { recentLogsAutoLoad = true; checkRecentLogsEnd(); }
});
new ResizeObserver(checkRecentLogsEnd).observe(logsContainer);
retryLogsButton.addEventListener('click', () => recentLogsNeedsSearch ? requestLogsSearch() : requestMoreRecentLogs());

// The current row toggles its menu; another row switches the menu immediately.
// Outside clicks dismiss it while leaving the clicked control's action intact.
document.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    if (rootButton.contains(event.target)) {
        if (pathMenu.hidden) openPathMenu(event.detail === 0);
        else closePathMenu();
        return;
    }
    if (pathMenu.contains(event.target)) {
        const item = event.target.closest('[data-path-action]');
        if (item && !item.disabled) {
            closePathMenu(true);
            vscode.postMessage({ type: item.dataset.pathAction, ...(item.dataset.path ? { path: item.dataset.path } : {}) });
        }
        return;
    }
    closePathMenu();
    if (resetRootButton.contains(event.target)) {
        fileActions.close();
        vscode.postMessage({ type: 'clearRootFolder' });
        return;
    }
    if (fileActions.element.contains(event.target)) {
        const action = event.target.closest('[data-action]');
        if (action) fileActions.activate(action.dataset.action);
        return;
    }
    const previousOwner = fileActions.owner;
    fileActions.close();
    const row = event.target.closest('.log-item');
    if (!row) return;
    selectPath(row.dataset.path);
    // Native click counts respect the user's double-click settings; no delay timer.
    if (previousOwner !== row && event.detail < 2) {
        fileActions.open(row, {
            point: event.detail > 0 ? { x: event.clientX, y: event.clientY } : null,
            focus: event.detail === 0,
        });
    }
});

document.addEventListener('dblclick', event => {
    const row = event.target instanceof Element && event.target.closest('.log-item');
    if (!row) return;
    fileActions.close();
    selectPath(row.dataset.path);
    vscode.postMessage({ type: 'openFile', path: row.dataset.path });
});

document.addEventListener('contextmenu', event => {
    closePathMenu();
    const row = event.target instanceof Element && event.target.closest('.log-item');
    if (!row) { fileActions.close(); return; }
    event.preventDefault();
    selectPath(row.dataset.path);
    fileActions.open(row, { point: { x: event.clientX, y: event.clientY } });
});

document.addEventListener('keydown', event => {
    if (!pathMenu.hidden) {
        if (event.key === 'Escape') { event.preventDefault(); closePathMenu(true); return; }
        if (event.key === 'Tab') { closePathMenu(pathMenu.contains(event.target)); return; }
        if (pathMenu.contains(event.target) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const items = [...pathMenu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
            const current = items.indexOf(document.activeElement);
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[index].focus();
            return;
        }
    }
    if (rootButton.contains(event.target) && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        openPathMenu(true, event.key === 'ArrowUp');
        return;
    }
    if (fileActions.isOpen && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        fileActions.close(true);
        return;
    }
    if (fileActions.isOpen && event.key === 'Tab') {
        fileActions.close(fileActions.element.contains(event.target));
        return; // Keep native Tab / Shift+Tab navigation.
    }
    if (fileActions.element.contains(event.target) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        fileActions.navigate(event.key);
        return;
    }
    const row = event.target instanceof Element && event.target.closest('.log-item');
    if (row && (['ArrowDown', 'ArrowUp', 'ContextMenu'].includes(event.key) || (event.shiftKey && event.key === 'F10'))) {
        event.preventDefault();
        selectPath(row.dataset.path);
        fileActions.open(row, { focus: true, last: event.key === 'ArrowUp' });
    }
});

document.addEventListener('scroll', event => {
    if (!fileActions.element.contains(event.target)) fileActions.close();
    if (!pathMenu.contains(event.target)) closePathMenu();
}, true);
window.addEventListener('resize', closeMenus);
window.addEventListener('blur', closeMenus);
document.addEventListener('visibilitychange', () => { if (document.hidden) closeMenus(); });

function showView(view) {
    closeMenus();
    for (const candidate of [mainView, fullLogsView]) candidate.classList.toggle('hidden', candidate !== view);
    if (view === mainView) checkRecentLogsEnd();
}

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
            document.getElementById('connect-server-btn').textContent = message.accountLabel || '로그인';
            {
                const usage = document.getElementById('usage-btn');
                usage.hidden = !message.usage;
                usage.textContent = message.usage?.label || '';
                usage.title = message.usage?.detail || '서버 사용량 확인';
                usage.disabled = message.usage?.status === 'loading';
            }
            rootDisplay.textContent = message.root || '현재 열려있는 모든 파일';
            rootButton.title = rootDisplay.textContent;
            rootHint.hidden = !message.root;
            if (typeof message.currentDirectory === 'string') updateCurrentDirectory(message.currentDirectory);
            recordingToggle.checked = message.isRecording;
            recordingStatusText.textContent = message.isRecording ? '실시간 기록 중' : '중지됨';
            recordingStatusText.style.color = message.isRecording
                ? 'var(--vscode-charts-green)'
                : 'inherit';

            langChips.forEach((chip) => {
                const lang = chip.getAttribute('data-lang');
                chip.setAttribute('aria-pressed', String(message.languages.includes(lang)));
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
                applyRecentLogs(message);
            }

            if (message.totalLogSize) {
                const manageBtnSpan = document.querySelector('#manage-logs-btn span:last-child');
                if (manageBtnSpan) {
                    manageBtnSpan.textContent = `전체 기록 (${message.totalLogSize})`;
                }
            }
            break;
        case 'currentDirectory':
            updateCurrentDirectory(message.path);
            break;
        case 'recentLogsPage': {
            if ((message.recentLogsSearchId ?? 0) !== recentLogsSearchId) break;
            const pending = message.requestId === pendingRecentLogsRequest;
            if (pending) pendingRecentLogsRequest = null;
            if (message.recentLogs) applyRecentLogs(message);
            if (pending && message.error && (hasMoreRecentLogs || recentLogsNeedsSearch)) recentLogsError = message.error;
            updateRecentLogsStatus();
            checkRecentLogsEnd();
            break;
        }
        case 'showFullLogs':
            showView(fullLogsView);
            renderLogs(message.logs, fullLogsContainer);
            break;
    }
});

recordingToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleRecording' });
});

langChips.forEach((chip) => {
    chip.tabIndex = 0;
    chip.setAttribute('role', 'button');
    chip.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            chip.click();
        }
    });
    chip.addEventListener('click', () => {
        vscode.postMessage({
            type: 'toggleLanguage',
            value: chip.getAttribute('data-lang'),
        });
    });
});

document.getElementById('generate-blog-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'generateBlog', path: selectedPath || currentLogs[0]?.filePath });
});

document.getElementById('manage-logs-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'manageLogs' });
});

document.getElementById('full-logs-back-btn').addEventListener('click', () => showView(mainView));

// 초기 데이터 요청
vscode.postMessage({ type: 'getInitialData' });

document
    .getElementById('connect-server-btn')
    .addEventListener('click', () => vscode.postMessage({ type: 'connectServer' }));
document.getElementById('sample-btn').addEventListener('click', () => vscode.postMessage({ type: 'sample' }));
document.getElementById('usage-btn').addEventListener('click', () => vscode.postMessage({ type: 'showUsage' }));
