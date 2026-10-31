const vscode = acquireVsCodeApi();
const el = id => document.getElementById(id);
const pending = new Map(), dirty = new Set();
let state, counter = 0;
const textFields = ['root', 'extensions'];
const display = (key, model) => key === 'extensions' ? model.extensions.map(ext => '.' + ext).join(', ') : model.root;
function send(type, extra = {}) {
    const id = ++counter;
    pending.set(id, { type, rootInput: el('root').value, ...extra, input: extra.field && textFields.includes(extra.field) ? el(extra.field).value : undefined });
    el('error').hidden = true;
    if (type !== 'ready') el('status').textContent = '저장 중…';
    vscode.postMessage({ type, id, ...extra });
}
function render() {
    if (!state) return;
    for (const field of textFields) { if (!dirty.has(field)) el(field).value = display(field, state); }
    for (const [id, key] of [['recording', 'recording'], ['prepare-on-review', 'prepareOnReview']]) {
        if (![...pending.values()].some(request => request.field === key)) el(id).checked = state[key];
    }
    el('current-directory').disabled = !state.currentDirectory;
    el('current-directory').title = state.currentDirectory || '';
}
window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'settings') { state = message; render(); return; }
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id);
    if (message.type === 'error') { el('error').textContent = message.message; el('error').hidden = false; el('status').textContent = ''; render(); return; }
    if (message.type === 'saved') {
        if (request.type === 'chooseFolder' && message.applied && el('root').value === request.rootInput) dirty.delete('root');
        if (request.field && textFields.includes(request.field) && el(request.field).value === request.input) dirty.delete(request.field);
        el('status').textContent = dirty.size ? '아직 적용하지 않은 변경 사항이 있습니다.' : '저장됨';
        render();
    }
});
for (const field of textFields) {
    el(field).addEventListener('input', () => { dirty.add(field); el('status').textContent = '입력 후 적용을 눌러 주세요.'; el('error').hidden = true; });
    el(field + '-form').addEventListener('submit', event => { event.preventDefault(); send('save', { field, value: field === 'extensions' ? el(field).value.split(/[\s,]+/).filter(Boolean) : el(field).value }); });
}
el('recording').onchange = event => send('save', { field: 'recording', value: event.target.checked });
el('prepare-on-review').onchange = event => send('save', { field: 'prepareOnReview', value: event.target.checked });
for (const [id, type] of [['choose-folder', 'chooseFolder'], ['current-directory', 'currentDirectory'], ['reset-root', 'resetRoot']]) {
    el(id).onclick = () => { if (type !== 'chooseFolder') dirty.delete('root'); send(type); };
}
send('ready');
