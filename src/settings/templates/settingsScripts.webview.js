const vscode = acquireVsCodeApi();
const el = id => document.getElementById(id);
const pending = new Map(), dirty = new Set();
let state, counter = 0;
const textFields = ['root', 'extensions', 'exportTags'];
const display = (key, model) => key === 'extensions' ? model.extensions.map(ext => '.' + ext).join(', ')
    : key === 'exportTags' ? Array.isArray(model.exportTags) ? model.exportTags.join(', ') : String(model.exportTags || '') : model.root;
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
    for (const [id, key] of [['recording', 'recording'], ['prepare-on-review', 'prepareOnReview'], ['ghost-auto-upload', 'ghostAutoUpload']]) {
        if (![...pending.values()].some(request => request.field === key)) el(id).checked = !!state[key];
    }
    if (![...pending.values()].some(request => request.field === 'ghostAutoUploadMode')) el('ghost-auto-mode').value = state.ghostAutoUploadMode === 'publish' ? 'publish' : 'draft';
    renderAutoUpload();
    el('current-directory').disabled = !state.currentDirectory;
    el('current-directory').title = state.currentDirectory || '';
    el('window-root-description').hidden = !state.windowRoot;
    if (state.supportEmail) {
        el('contact').textContent = state.supportEmail;
        el('contact').href = 'mailto:' + state.supportEmail;
    }
}
function renderAutoUpload() {
    el('ghost-auto-mode').disabled = !el('ghost-auto-upload').checked;
    el('ghost-mode-description').textContent = el('ghost-auto-mode').value === 'publish'
        ? 'Publish는 글이 완성되면 별도 확인 없이 공개 게시합니다.'
        : 'Draft는 비공개 초안으로 저장합니다. 이미 공개된 글은 자동으로 수정하지 않습니다.';
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
el('ghost-auto-upload').onchange = event => { renderAutoUpload(); send('save', { field: 'ghostAutoUpload', value: event.target.checked }); };
el('ghost-auto-mode').onchange = event => { renderAutoUpload(); send('save', { field: 'ghostAutoUploadMode', value: event.target.value }); };
el('connect-ghost').onclick = () => send('connectGhost');
el('contact').onclick = event => { event.preventDefault(); vscode.postMessage({ type: 'contact' }); };
for (const [id, type] of [['choose-folder', 'chooseFolder'], ['current-directory', 'currentDirectory'], ['reset-root', 'resetRoot']]) {
    el(id).onclick = () => { if (type !== 'chooseFolder') dirty.delete('root'); send(type); };
}
send('ready');
