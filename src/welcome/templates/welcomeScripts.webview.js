const vscode = acquireVsCodeApi();
const buttons = [...document.querySelectorAll('[data-action]')];
const status = document.getElementById('welcome-status');
const error = document.getElementById('welcome-error');
let busy = false;
for (const button of buttons) {
    button.addEventListener('click', () => {
        if (busy) return;
        busy = true;
        for (const item of buttons) item.disabled = true;
        error.hidden = true;
        status.textContent = button.dataset.action === 'connect' ? '계정을 확인하고 있어요…' : '열고 있어요…';
        vscode.postMessage({ type: 'action', action: button.dataset.action });
    });
}
window.addEventListener('message', event => {
    if (event.data?.type !== 'actionResult') return;
    busy = false;
    for (const button of buttons) button.disabled = false;
    status.textContent = '';
    error.textContent = event.data.error || '';
    error.hidden = !event.data.error;
});
