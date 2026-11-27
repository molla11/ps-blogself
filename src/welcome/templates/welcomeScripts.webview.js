import { renderModifiedTime } from '../../webview/modifiedTime';

const vscode = acquireVsCodeApi();
const status = document.getElementById('welcome-status');
const error = document.getElementById('welcome-error');
const list = document.getElementById('code-files');
let busy = false;

function setBusy(value) {
    busy = value;
    for (const button of document.querySelectorAll('[data-action]')) button.disabled = value;
}

function showFiles({ files, total, searching, failed, hasFolder }) {
    const activePath = document.activeElement?.dataset.path;
    const activeAction = document.activeElement?.dataset.action;
    const rows = [];
    for (const file of files) {
        const row = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'file-link';
        button.dataset.action = 'openFile';
        button.dataset.path = file.filePath;
        button.title = file.filePath;
        button.disabled = busy;
        const name = document.createElement('span');
        name.className = 'file-name';
        name.textContent = file.fileName;
        const modified = document.createElement('time');
        renderModifiedTime(modified, file.lastModified, file.language);
        button.append(name, modified);
        const write = document.createElement('button');
        write.type = 'button';
        write.className = 'file-write';
        write.dataset.action = 'write';
        write.dataset.path = file.filePath;
        write.textContent = '글쓰기';
        write.setAttribute('aria-label', file.fileName + ' 글쓰기');
        write.disabled = busy;
        row.append(button, write);
        rows.push(row);
    }
    list.replaceChildren(...rows);
    if (activePath) {
        [...list.querySelectorAll('button')].find(button => button.dataset.path === activePath && button.dataset.action === activeAction)
            ?.focus({ preventScroll: true });
    }
    const count = document.getElementById('file-count');
    count.hidden = !total;
    count.textContent = total > files.length ? `${total}개 중 ${files.length}개` : `${total}개`;
    const start = document.getElementById('start-file');
    const create = !total && !searching && !failed && hasFolder;
    start.hidden = !total && searching;
    start.dataset.action = total ? 'chooseFile' : create ? 'createFile' : 'openFolder';
    start.textContent = total ? '코드 목록 열기' : create ? '코드 파일 만들기' : '폴더 열기';
    start.disabled = busy;
    document.getElementById('other-folder').hidden = !create;
    document.getElementById('files-status').textContent = failed ? '폴더의 코드 파일을 모두 불러오지 못했습니다.'
        : searching ? '코드 파일을 찾는 중…' : total ? ''
        : hasFolder ? '이 폴더에는 .c, .cpp, .py 파일이 없습니다. 첫 코드 파일을 만들어 보세요.'
        : 'C, C++ 또는 Python 코드가 있는 폴더를 열어 주세요.';
}

document.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button || busy) return;
    setBusy(true);
    error.hidden = true;
    const action = button.dataset.action;
    status.textContent = action === 'connect' ? '계정을 확인하고 있어요…' : '열고 있어요…';
    vscode.postMessage({ type: 'action', action, ...(button.dataset.path ? { path: button.dataset.path } : {}) });
});
window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'codeFiles') { showFiles(message); return; }
    if (message?.type !== 'actionResult') return;
    setBusy(false);
    status.textContent = '';
    error.textContent = message.error || '';
    error.hidden = !message.error;
});
vscode.postMessage({ type: 'ready' });
