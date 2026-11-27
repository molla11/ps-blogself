const vscode = acquireVsCodeApi();
const entries = document.getElementById('history-entries');
const progress = document.getElementById('history-progress');
const retry = document.getElementById('history-retry');
let firstEntry = entries.firstElementChild;
const { loadId } = entries.dataset;
document.getElementById('writing-actions').hidden = entries.dataset.recorded !== 'true';
const total = Number(entries.dataset.total);
let loaded = 0, offset = 0, pending = false, scheduled = false, failed = false;

const post = message => vscode.postMessage({ ...message, loadId });
function schedule() {
    if (scheduled || pending || failed || loaded >= total || document.hidden) return;
    scheduled = true;
    const run = () => {
        scheduled = false;
        if (pending || failed || document.hidden || loaded >= total) return;
        pending = true;
        post({ type: 'loadHistory', offset });
    };
    // Independent of scroll position; leave time for input and painting between entries.
    if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 250 });
    else setTimeout(run, 16);
}
function updateProgress() {
    if (firstEntry) progress.textContent = `최근 수정 기록 표시 중 · 전체 ${total}개`;
    else progress.textContent = loaded === total ? `${total}개 기록을 모두 불러왔습니다.` : `${loaded} / ${total}개 불러오는 중…`;
    entries.setAttribute('aria-busy', String(loaded < total));
}
window.addEventListener('message', ({ data }) => {
    if (data.type === 'preparation') {
        document.getElementById('preparation-status').textContent = data.text;
        return;
    }
    if (data.loadId !== loadId || !pending || data.offset !== offset) return;
    if (data.type === 'historyError') {
        pending = false;
        failed = true;
        progress.textContent = `${firstEntry ? 1 : loaded} / ${total}개 표시됨. 나머지 기록을 불러오지 못했습니다.`;
        entries.setAttribute('aria-busy', 'false');
        retry.hidden = false;
        return;
    }
    if (data.type !== 'historyEntry' || data.index !== total - loaded - 1) return;
    if (firstEntry) {
        // Keep the header and its focused button while upgrading the visible lines.
        firstEntry.querySelector('tbody').innerHTML = data.rows;
        firstEntry = null;
    } else {
        if (data.html) entries.insertAdjacentHTML('beforeend', data.html);
        entries.lastElementChild.querySelector('tbody').insertAdjacentHTML('beforeend', data.rows);
    }
    offset++;
    if (data.complete) loaded++;
    pending = false;
    updateProgress();
    schedule();
});
entries.addEventListener('click', event => {
    const button = event.target.closest('button[data-index]');
    if (!button || !entries.contains(button)) return;
    post({ type: button.classList.contains('delete-btn') ? 'deleteSnapshot' : 'viewSnapshot', index: Number(button.dataset.index) });
});
document.getElementById('write-btn').addEventListener('click', () => post({ type: 'write' }));
retry.addEventListener('click', () => { retry.disabled = true; post({ type: 'reloadHistory' }); });
document.addEventListener('visibilitychange', schedule);
updateProgress();
post({ type: 'ready' });
schedule();
