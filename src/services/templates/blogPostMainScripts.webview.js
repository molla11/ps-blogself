import { createArticleEditor } from './articleEditor.webview.js';
import { observeCodeHighlighting } from './codeHighlighting.js';

const vscode = acquireVsCodeApi();
observeCodeHighlighting(document.body);
const el = (id) => document.getElementById(id);
let model,
    form = {},
    counter = 0,
    activeTab = 'plan',
    lastMarkdown = '',
    editTimer,
    previewMode = false,
    sourceMode = false,
    outlineOpen = false,
    selectedVersion = '',
    readyVersion = '',
    restoreRequest;
const dirty = new Set(),
    sent = new Map();
const recovered = vscode.getState();
let localRecovery = recovered?.localRecovery;
let recoveryApplied = false;
const imageRequests = new Map();
let ghostState = { connected: false };
const richEditor = createArticleEditor({
    element: el('rich-editor'), toolbar: el('format-tools'), outline: el('outline-list'),
    onChange(markdown, document) {
        form.document = document;
        changed('document');
        form.markdown = markdown;
        value('article-body', markdown);
        changed('markdown');
    },
    onOpenLink(url) { send('openLink', { url }); },
    onError(message) { el('error-text').textContent = message; el('error-box').hidden = false; },
    async onImageFile(file) {
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.')); reader.readAsDataURL(file); });
        return new Promise((resolve, reject) => { const id = send('importImage', { data }); const timer = setTimeout(() => { imageRequests.delete(id); reject(new Error('이미지 저장 시간이 초과되었습니다. 다시 시도해 주세요.')); }, 30000); imageRequests.set(id, { resolve, reject, timer }); });
    },
});
function height(node) {
    if (node.tagName === 'TEXTAREA' && !node.closest('[hidden]')) {
        node.style.height = 'auto';
        node.style.height = Math.max(node.id === 'article-title' ? 0 : 70, node.scrollHeight + 2) + 'px';
    }
}
function stash() {
    vscode.setState({
        filePath: model?.filePath || recovered?.filePath,
        editToken: model?.editToken || recovered?.editToken,
        fields: Object.fromEntries([...dirty].map((key) => [key, form[key]])),
        localRecovery,
    });
}
function send(type, extra = {}, fields = false) {
    const id = String(++counter),
        payload = fields ? JSON.parse(JSON.stringify(form)) : undefined;
    if (fields) sent.set(id, payload);
    vscode.postMessage({ type, id, editToken: model?.editToken, ...(fields ? { fields: payload } : {}), ...extra });
    return id;
}
function changed(key) {
    if (model?.editable === false) return;
    dirty.add(key);
    renderGhost();
    el('save-status').textContent = '저장 중…';
    stash();
    clearTimeout(editTimer);
    editTimer = setTimeout(() => send('save', {}, true), 250);
}
function value(id, text) {
    const node = el(id);
    if (node.value !== (text || '')) node.value = text || '';
    height(node);
}
function action(type) {
    clearTimeout(editTimer);
    send(type, {}, true);
}
function range() {
    const p = form.plan;
    if (!p) return;
    el('range-info').textContent =
        p.start === p.end
            ? `변경 #${p.start + 1} 선택됨`
            : `변경 #${p.start + 1}–${p.end + 1} 선택됨 · ${p.end - p.start + 1}개`;
    for (const key of ['start', 'end']) {
        el('range-' + key).max = String(model.count - 1);
        el('range-' + key).value = String(p[key]);
        el(key + '-label').textContent = '#' + (p[key] + 1);
    }
    const denominator = Math.max(1, model.count - 1);
    el('timeline-range').style.left = (p.start / denominator) * 100 + '%';
    el('timeline-range').style.width =
        (model.count === 1 ? 100 : ((p.end - p.start) / denominator) * 100) + '%';
}
function diffDisclosure(start, end) {
    const details = document.createElement('details'),
        summary = document.createElement('summary');
    summary.className = 'diff-toggle';
    summary.textContent = '코드 변화 보기';
    details.appendChild(summary);
    const holder = document.createElement('div');
    details.appendChild(holder);
    details.addEventListener('toggle', () => {
        if (!details.open || holder.childElementCount) return;
        for (let index = start; index <= end; index++) {
            const item = document.createElement('details'),
                label = document.createElement('summary'),
                pre = document.createElement('pre');
            label.textContent = '변경 #' + (index + 1);
            pre.className = 'diff-code';
            pre.dataset.diff = String(index);
            pre.textContent = '불러오는 중…';
            item.append(label, pre);
            holder.appendChild(item);
            item.addEventListener('toggle', () => {
                if (item.open) send('diff', { index });
            });
            if (start === end) item.open = true;
        }
    });
    return details;
}
function renderSteps() {
    const container = el('steps'),
        plan = form.plan;
    if (!plan) return;
    const structure = JSON.stringify(plan.steps.map((s) => [s.start, s.end]));
    if (container.dataset.structure !== structure) {
        container.replaceChildren();
        container.dataset.structure = structure;
        plan.steps.forEach((step, index) => {
            const section = document.createElement('section');
            section.className = 'step';
            const row = document.createElement('div');
            row.className = 'step-title';
            const number = document.createElement('span');
            number.textContent = String(index + 1).padStart(2, '0');
            const title = document.createElement('input');
            title.id = 'step-title-' + index;
            title.maxLength = 300;
            title.setAttribute('aria-label', `${index + 1}단계 제목`);
            title.addEventListener('input', () => {
                form.plan.steps[index].title = title.value;
                changed('plan');
            });
            row.append(number, title);
            const body = document.createElement('textarea');
            body.id = 'step-body-' + index;
            body.rows = 3;
            body.maxLength = 12000;
            body.setAttribute('aria-label', `${index + 1}단계 설명`);
            body.addEventListener('input', () => {
                form.plan.steps[index].body = body.value;
                height(body);
                changed('plan');
            });
            section.append(row, body, diffDisclosure(step.start, step.end));
            container.appendChild(section);
        });
    }
    plan.steps.forEach((step, index) => {
        container.children[index].hidden = step.end < plan.start || step.start > plan.end;
        value('step-title-' + index, step.title);
        value('step-body-' + index, step.body);
    });
}
function switchTab(tab) {
    activeTab = tab;
    el('plan-view').hidden = tab !== 'plan';
    el('article-view').hidden = tab !== 'article';
    el('plan-tab').classList.toggle('active', tab === 'plan');
    el('article-tab').classList.toggle('active', tab === 'article');
    el('plan-tab').setAttribute('aria-pressed', String(tab === 'plan'));
    el('article-tab').setAttribute('aria-pressed', String(tab === 'article'));
    document.querySelectorAll('textarea').forEach(height);
}
function renderEditorMode() {
    const browsing = !!selectedVersion;
    el('rich-editor').hidden = previewMode || sourceMode;
    el('body-field').hidden = previewMode || !sourceMode;
    el('article-preview').hidden = !previewMode;
    el('format-bar').hidden = browsing || previewMode || sourceMode;
    el('source-btn').hidden = browsing;
    el('source-btn').setAttribute('aria-pressed', String(sourceMode && !previewMode));
    el('preview-btn').setAttribute('aria-pressed', String(previewMode));
    el('preview-btn').textContent = previewMode ? '편집으로 돌아가기' : '미리보기';
    el('article-outline').hidden = !outlineOpen || browsing || previewMode || sourceMode;
    el('outline-toggle').setAttribute('aria-expanded', String(!el('article-outline').hidden));
    el('outline-toggle').disabled = browsing || previewMode || sourceMode;
    el('insert-block-btn').disabled = model?.editable === false;
    richEditor.setActive(!browsing && !previewMode && !sourceMode);
    document.querySelectorAll('textarea').forEach(height);
}
function renderVersions() {
    renderGhost();
    const versions = model.versions || [], select = el('version-select');
    if (selectedVersion && !versions.some(version => version.id === selectedVersion)) {
        selectedVersion = '';
        readyVersion = '';
    }
    const structure = JSON.stringify(versions);
    if (select.dataset.structure !== structure) {
        select.dataset.structure = structure;
        const current = document.createElement('option');
        current.value = '';
        current.textContent = '현재 글';
        select.replaceChildren(current);
        versions.slice().reverse().forEach((version, index) => {
            const option = document.createElement('option');
            option.value = version.id;
            const date = new Date(version.at).toLocaleString('ko-KR', {
                month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
            });
            option.textContent = `${index + 1}개 전 · ${date} · ${version.title || '제목 없음'}`;
            select.appendChild(option);
        });
    }
    select.value = selectedVersion;
    select.disabled = !!restoreRequest;
    const browsing = !!selectedVersion, loading = browsing && readyVersion !== selectedVersion;
    el('versions-box').hidden = !versions.length;
    el('version-older-btn').disabled = !!restoreRequest || select.selectedIndex >= select.options.length - 1;
    el('version-newer-btn').disabled = !!restoreRequest || select.selectedIndex <= 0;
    el('restore-version-btn').hidden = !browsing;
    el('restore-version-btn').disabled = model.editable === false || loading || !!restoreRequest;
    el('current-article').hidden = browsing;
    el('version-preview').hidden = !browsing;
    el('preview-btn').hidden = browsing;
    el('copy-btn').disabled = loading;
    el('export-btn').disabled = loading;
    el('export-html-btn').disabled = loading;
    renderEditorMode();
}
function chooseVersion(id) {
    if (restoreRequest || id === selectedVersion) return;
    selectedVersion = id;
    readyVersion = '';
    el('version-title').textContent = '';
    el('version-body').replaceChildren();
    el('version-status').textContent = '이전 버전을 불러오는 중…';
    renderVersions();
    if (id) send('previewVersion', { versionId: id });
    document.querySelectorAll('textarea').forEach(height);
}
function renderLoading() {
    const busy = !!(model.pending || model.running) && !model.error;
    el('generation-loading').hidden = !busy;
    if (!busy) return false;
    const kind = model.pendingKind || (form.plan ? 'write_blog' : 'prepare_blog');
    el('loading-title').textContent = kind === 'prepare_blog' ? '준비 중…' : '작성 중…';
    return true;
}
function render() {
    renderGhost();
    const busy = renderLoading();
    const editable = model.editable !== false;
    el('ownership-box').hidden = editable;
    el('recovery-box').hidden = !localRecovery;
    el('recover-input-btn').disabled = !editable;
    el('stream-box').hidden = !model.streamHtml;
    el('stream-preview').innerHTML = model.streamHtml || '';
    el('file-name').textContent = model.fileName;
    el('status-text').textContent =
        model.status ||
        (form.plan
            ? '준비된 내용을 그대로 사용하거나 자유롭게 고쳐보세요.'
            : '풀이 흐름을 준비해 주세요.');
    el('progress-box').hidden = !model.pending && !model.running && !/저장|복사|적용|취소/.test(model.status || '');
    el('error-box').hidden = !model.error;
    el('error-text').textContent = model.error || '';
    el('cancel-btn').hidden = !model.pending;
    el('discard-pending-btn').hidden = !model.pending || model.running;
    el('candidate-box').hidden = !model.candidate;
    el('preparing').hidden = !!form.plan || busy;
    el('prepare-empty-btn').hidden = !!model.pending || !!model.running || !!model.candidate;
    el('preparing').querySelector('p').textContent = model.error
        ? '안내를 확인한 뒤 다시 시도할 수 있어요.'
        : '변경 구간과 풀이 설명을 먼저 채워드릴게요.';
    el('plan-content').hidden = !form.plan;
    el('generate-btn').disabled = !form.plan || model.pending;
    el('generate-btn').textContent = model.pending
        ? (model.pendingKind === 'prepare_blog' || !form.plan ? '준비 중…' : '작성 중…')
        : form.markdown ? '글 다시 쓰기' : '이대로 글쓰기';
    el('prepare-btn').disabled = model.pending;
    el('retry-btn').disabled = model.running;
    value('instructions', form.instructions);
    value('writing-style', form.writingStyle || 'plain');
    value('custom-style', form.customStyle);
    el('custom-style-field').hidden = form.writingStyle !== 'custom';
    el('writing-style').disabled = !editable;
    height(el('custom-style'));
    if (form.plan) {
        value('plan-title', form.plan.title);
        value('summary', form.plan.summary);
        range();
        renderSteps();
    }
    value('article-title', form.title);
    value('article-body', form.markdown);
    richEditor.setMarkdown(form.markdown, editable, form.document, model.images);
    el('article-tab').disabled = !form.markdown && !form.title && !model.versions.length && activeTab !== 'article';
    if (form.markdown && !lastMarkdown) {
        switchTab('article');
        send('preview');
    } else if (form.markdown !== lastMarkdown && previewMode) {
        send('preview');
    }
    lastMarkdown = form.markdown || '';
    if (el('article-tab').disabled) switchTab('plan');
    renderVersions();
    document.querySelectorAll('textarea, input:not([type="range"])').forEach(node => { node.readOnly = !editable; });
    document.querySelectorAll('input[type="range"]').forEach(node => { node.disabled = !editable; });
    for (const id of ['generate-btn', 'prepare-btn', 'prepare-empty-btn', 'retry-btn', 'cancel-btn', 'discard-pending-btn', 'apply-candidate-btn', 'discard-candidate-btn']) {
        if (!editable) el(id).disabled = true;
        else if (!['generate-btn', 'prepare-btn', 'retry-btn'].includes(id)) el(id).disabled = false;
    }
    stash();
}
window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'imageReady' || message.type === 'saveError' && imageRequests.has(message.id)) {
        const request = imageRequests.get(message.id); if (request) { clearTimeout(request.timer); imageRequests.delete(message.id); if (message.type === 'imageReady') request.resolve(message); else request.reject(new Error(message.message)); }
        return;
    }
    if (message.type === 'ghost') { ghostState = message.state; renderGhost(); return; }
    if (message.type === 'model') {
        if (message.ghost) ghostState = message.ghost;
        renderGhost();
        if (message.editable === false || (model?.editToken && message.editToken !== model.editToken)) {
            if (dirty.size) localRecovery = Object.fromEntries([...dirty].map(key => [key, structuredClone(form[key])]));
            dirty.clear(); sent.clear(); clearTimeout(editTimer);
        }
        model = message;
        for (const key of ['plan', 'instructions', 'writingStyle', 'customStyle', 'title', 'markdown', 'document']) {
            if (!dirty.has(key)) form[key] = structuredClone(message[key]);
        }
        if (!recoveryApplied) {
            recoveryApplied = true;
            if (recovered?.filePath === model.filePath && recovered.fields && Object.keys(recovered.fields).length) {
                if (model.editable === false || (recovered.editToken && recovered.editToken !== model.editToken)) localRecovery ||= recovered.fields;
                else {
                    for (const [key, val] of Object.entries(recovered.fields)) {
                        if (['plan', 'instructions', 'writingStyle', 'customStyle', 'title', 'markdown', 'document'].includes(key)) {
                            form[key] = val;
                            dirty.add(key);
                        }
                    }
                    if (dirty.size) send('save', {}, true);
                }
            }
        }
        render();
    } else if (message.type === 'ack') {
        const fields = sent.get(message.id);
        if (fields) {
            for (const key of [...dirty]) {
                if (JSON.stringify(form[key]) === JSON.stringify(fields[key])) dirty.delete(key);
            }
            sent.delete(message.id);
            stash();
            if (!dirty.size) el('save-status').textContent = '저장됨';
        }
        if (message.id === restoreRequest) {
            restoreRequest = undefined;
            selectedVersion = '';
            renderVersions();
        }
    } else if (message.type === 'saveError') {
        el('save-status').textContent = '저장 확인 필요';
        if (message.id === restoreRequest) {
            restoreRequest = undefined;
            renderVersions();
        }
    } else if (message.type === 'preview') {
        el('article-preview').innerHTML = message.html;
        renderEditorMode();
    } else if (message.type === 'versionPreview') {
        if (!selectedVersion || message.versionId !== selectedVersion) return;
        readyVersion = message.versionId;
        el('version-status').textContent = '이전 버전 미리보기';
        el('version-title').textContent = message.title || '제목 없음';
        el('version-body').innerHTML = message.html;
        renderVersions();
    } else if (message.type === 'diff') {
        document.querySelectorAll(`[data-diff="${message.index}"]`).forEach((pre) => {
            pre.replaceChildren();
            const lines = message.text.split('\n');
            for (const line of lines.slice(0, 1500)) {
                const span = document.createElement('span');
                span.className =
                    'diff-line' +
                    (line.startsWith('+')
                        ? ' diff-added'
                        : line.startsWith('-')
                          ? ' diff-removed'
                          : '');
                span.textContent = line || ' ';
                pre.appendChild(span);
            }
            if (lines.length > 1500) {
                pre.appendChild(
                    document.createTextNode('\n… 큰 변경은 앞부분 1,500줄만 표시합니다.'),
                );
            }
        });
    }
});
el('takeover-btn').addEventListener('click', () => send('takeover'));
el('recover-input-btn').addEventListener('click', () => {
    if (model?.editable === false || !localRecovery) return;
    for (const [key, value] of Object.entries(localRecovery)) { form[key] = structuredClone(value); dirty.add(key); }
    localRecovery = undefined;
    render();
    action('save');
});
for (const [id, key] of [
    ['instructions', 'instructions'],
    ['custom-style', 'customStyle'],
    ['article-title', 'title'],
    ['article-body', 'markdown'],
]) {
    el(id).addEventListener('input', (event) => {
        form[key] = event.target.value;
        height(event.target);
        changed(key);
        if (key === 'markdown') { form.document = null; changed('document'); richEditor.setMarkdown(form.markdown, model?.editable !== false); }
    });
}
el('writing-style').addEventListener('change', (event) => {
    form.writingStyle = event.target.value;
    changed('writingStyle');
    el('custom-style-field').hidden = form.writingStyle !== 'custom';
    height(el('custom-style'));
});
el('plan-title').addEventListener('input', (event) => {
    form.plan.title = event.target.value;
    changed('plan');
});
el('summary').addEventListener('input', (event) => {
    form.plan.summary = event.target.value;
    height(event.target);
    changed('plan');
});
el('prepare-empty-btn').addEventListener('click', () => action('prepare'));
el('version-select').addEventListener('change', event => chooseVersion(event.target.value));
for (const [id, offset] of [['version-older-btn', 1], ['version-newer-btn', -1]]) {
    el(id).addEventListener('click', () => {
        const select = el('version-select');
        const option = select.options[select.selectedIndex + offset];
        if (option) chooseVersion(option.value);
    });
}
el('restore-version-btn').addEventListener('click', () => {
    if (!selectedVersion || model.editable === false || restoreRequest) return;
    clearTimeout(editTimer);
    restoreRequest = send('restore', { versionId: selectedVersion }, true);
    renderVersions();
});
for (const key of ['start', 'end']) {
    el('range-' + key).addEventListener('input', (event) => {
        const p = form.plan,
            index = Number(event.target.value);
        p[key] = index;
        if (p.start > p.end) p[key === 'start' ? 'end' : 'start'] = index;
        // Keep the author's text, while excluding explanations whose code is outside the new range.
        // Excluded explanations remain saved so widening the range restores the author's text.
        changed('plan');
        range();
        renderSteps();
        if (el('range-details').open) {
            el('range-changes').replaceChildren(diffDisclosure(p.start, p.end));
        }
    });
}
el('range-details').addEventListener('toggle', () => {
    if (!el('range-details').open || !model) return;
    const holder = el('range-changes');
    holder.replaceChildren();
    holder.appendChild(diffDisclosure(form.plan.start, form.plan.end));
});
for (const [id, type] of [
    ['generate-btn', 'generate'],
    ['prepare-btn', 'prepare'],
    ['retry-btn', 'retry'],
    ['apply-candidate-btn', 'applyCandidate'],
]) {
    el(id).addEventListener('click', () => {
        if (type === 'generate') chooseVersion('');
        action(type);
    });
}
for (const [id, type, format] of [['copy-btn', 'copy'], ['export-btn', 'export', 'markdown'], ['export-html-btn', 'export', 'html']]) {
    el(id).addEventListener('click', () => {
        el('export-menu').hidePopover();
        if (selectedVersion) send(type, { versionId: selectedVersion, format });
        else { clearTimeout(editTimer); send(type, { format }, true); }
    });
}
for (const [id, type] of [
    ['connect-btn', 'connect'],
    ['cancel-btn', 'cancel'],
    ['discard-candidate-btn', 'discardCandidate'],
    ['discard-pending-btn', 'discardPending'],
]) {
    el(id).addEventListener('click', () => send(type));
}
el('plan-tab').addEventListener('click', () => switchTab('plan'));
el('article-tab').addEventListener('click', () => switchTab('article'));
window.addEventListener('resize', () => document.querySelectorAll('textarea').forEach(height));
window.addEventListener('pagehide', () => {
    if (dirty.size) send('save', {}, true);
});
send('ready');

el('preview-btn').addEventListener('click', () => {
    previewMode = !previewMode;
    renderEditorMode();
    if (previewMode) action('preview');
    else if (sourceMode) el('article-body').focus({ preventScroll: true });
    else richEditor.focus({ preventScroll: true });
});
el('source-btn').addEventListener('click', () => {
    sourceMode = !sourceMode; previewMode = false; renderEditorMode();
    if (sourceMode) el('article-body').focus({ preventScroll: true });
    else richEditor.focus({ preventScroll: true });
});
el('outline-toggle').addEventListener('click', () => { outlineOpen = !outlineOpen; renderEditorMode(); });
el('export-menu').addEventListener('beforetoggle', event => {
    if (event.newState !== 'open') return;
    const rect = el('export-menu-btn').getBoundingClientRect();
    el('export-menu').style.top = Math.max(8, Math.min(rect.bottom + 5, innerHeight - 300)) + 'px';
    el('export-menu').style.left = Math.max(8, Math.min(rect.right - 184, innerWidth - 192)) + 'px';
});
document.querySelectorAll('.action-menu').forEach(menu => menu.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')].filter(button => !button.hidden);
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index].focus();
}));
document.querySelectorAll('.article-preview').forEach(preview => preview.addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (link) {
        event.preventDefault();
        send('openLink', { url: link.href });
    }
}));

function renderGhost() {
    const g = ghostState;
    el('ghost-save-btn').textContent = g.busy ? 'Ghost 저장 중…' : g.status === 'published' ? 'Ghost 변경 사항 저장' : 'Ghost 초안 저장';
    el('ghost-save-btn').disabled = el('ghost-publish-btn').disabled = !!g.busy || model?.editable === false || !!selectedVersion;
    el('ghost-connect-btn').disabled = !!g.busy;
    el('ghost-open-btn').hidden = !g.editorUrl;
    el('ghost-publish-btn').hidden = g.status === 'published';
    el('ghost-status').hidden = !g.connected && !g.error;
    if (!g.connected && !g.busy && !g.error) {
        el('ghost-status').textContent = '';
        return;
    }
    el('ghost-status').textContent = g.error || (g.busy ? 'Ghost에 저장하고 있어요. 계속 편집해도 됩니다.' : g.postId ? `${new URL(g.site).host} · ${g.status === 'published' ? '게시됨' : '초안'}${g.synced && !dirty.has('markdown') && !dirty.has('title') && !dirty.has('document') ? ' · 최신 내용 저장됨' : ' · 변경 사항을 저장해 주세요'}` : `${new URL(g.site).host} · Ghost에 연결됨`);
}
for (const [id, type] of [['ghost-save-btn', 'ghostSave'], ['ghost-publish-btn', 'ghostPublish'], ['ghost-connect-btn', 'ghostConnect'], ['ghost-open-btn', 'ghostOpen']]) {
    el(id).onclick = () => { el('export-menu').hidePopover(); clearTimeout(editTimer); send(type, {}, type === 'ghostSave' || type === 'ghostPublish'); };
}
