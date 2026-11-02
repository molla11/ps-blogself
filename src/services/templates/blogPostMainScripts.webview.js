import { createArticleEditor } from './articleEditor.webview.js';
import { observeCodeHighlighting } from './codeHighlighting.js';
import { DEFAULT_WRITING_MODEL } from '../../writing/WritingModels';

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
const modelOptions = [...el('writing-model-options').querySelectorAll('[role=option]')];
// Keep the UI within validatePlan's saved-step limit.
const MAX_MEMOS = 12;
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
        const minimum = node.id === 'article-title' || node.id === 'summary' || node.closest('.step') ? 0 : 70;
        node.style.height = Math.max(minimum, node.scrollHeight + 2) + 'px';
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
function insertMemo(index) {
    const plan = form.plan;
    if (!plan || model?.editable === false || plan.steps.length >= MAX_MEMOS) return;
    const inRange = step => step.end >= plan.start && step.start <= plan.end;
    const neighbor = plan.steps.slice(index).find(inRange) || plan.steps.slice(0, index).reverse().find(inRange);
    plan.steps.splice(index, 0, {
        title: '', body: '',
        start: Math.max(plan.start, neighbor?.start ?? plan.start),
        end: Math.min(plan.end, neighbor?.end ?? plan.end),
    });
    changed('plan');
    renderSteps();
    el('step-body-' + index).focus();
}
function memoInsertion(index, label) {
    const row = document.createElement('div');
    row.className = 'memo-insertion';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiet memo-add';
    button.textContent = '메모 추가';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => insertMemo(index));
    row.appendChild(button);
    return row;
}
function renderSteps() {
    const container = el('steps'),
        plan = form.plan;
    if (!plan) return;
    const visible = plan.steps.map((step, index) => ({ step, index }))
        .filter(({ step }) => step.end >= plan.start && step.start <= plan.end);
    const structure = JSON.stringify([plan.start, plan.end, plan.steps.map((s) => [s.start, s.end])]);
    if (container.dataset.structure !== structure) {
        container.replaceChildren();
        container.dataset.structure = structure;
        container.appendChild(memoInsertion(visible[0]?.index ?? plan.steps.length, '첫 메모 추가'));
        visible.forEach(({ step, index }, position) => {
            const label = `메모 #${position + 1}`;
            const section = document.createElement('section');
            section.className = 'step';
            section.setAttribute('aria-labelledby', 'memo-label-' + index);
            const row = document.createElement('div');
            row.className = 'step-heading';
            const number = document.createElement('h3');
            number.id = 'memo-label-' + index;
            number.textContent = label;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'quiet step-remove';
            remove.textContent = '삭제';
            remove.setAttribute('aria-label', `${label} 삭제`);
            remove.addEventListener('click', () => {
                if (model?.editable === false) return;
                form.plan.steps.splice(index, 1);
                changed('plan');
                renderSteps();
                const remaining = container.querySelectorAll('.step textarea');
                (remaining[Math.min(position, remaining.length - 1)] || container.querySelector('.memo-add')).focus();
            });
            row.append(number, remove);
            const title = document.createElement('input');
            title.id = 'step-title-' + index;
            title.maxLength = 300;
            title.placeholder = '메모 제목 (선택)';
            title.setAttribute('aria-label', `${label} 제목`);
            title.addEventListener('input', () => {
                form.plan.steps[index].title = title.value;
                changed('plan');
            });
            const body = document.createElement('textarea');
            body.id = 'step-body-' + index;
            body.rows = 1;
            body.maxLength = 12000;
            body.placeholder = '바꾼 내용과 이유를 적어보세요.';
            body.setAttribute('aria-label', `${label} 내용`);
            body.addEventListener('input', () => {
                form.plan.steps[index].body = body.value;
                height(body);
                changed('plan');
            });
            const start = Math.max(step.start, plan.start), end = Math.min(step.end, plan.end);
            const code = diffDisclosure(start, end);
            code.querySelector('summary').textContent = `변경 #${start + 1}${start === end ? '' : '–' + (end + 1)} · 코드 변화 보기`;
            section.append(row, title, body, code);
            container.appendChild(section);
            container.appendChild(memoInsertion(index + 1, `${label} 뒤에 메모 추가`));
        });
    }
    visible.forEach(({ step, index }) => {
        value('step-title-' + index, step.title);
        value('step-body-' + index, step.body);
    });
    const editable = model?.editable !== false;
    container.querySelectorAll('input, textarea').forEach(node => { node.readOnly = !editable; });
    container.querySelectorAll('.step-remove').forEach(button => { button.disabled = !editable; });
    container.querySelectorAll('.memo-add').forEach(button => { button.disabled = !editable || plan.steps.length >= MAX_MEMOS; });
    el('memo-limit').hidden = plan.steps.length < MAX_MEMOS;
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
function renderWritingMode() {
    const mode = form.writingMode || 'evolution';
    value('writing-mode', mode);
    el('writing-mode-help').textContent = {
        evolution: '이전 코드와 수정 이유, 바뀐 결과를 따라가며 씁니다.',
        solution: '현재 코드의 핵심 아이디어와 동작 원리를 설명합니다.',
        algorithm: '사용한 알고리즘·자료구조의 원리부터 이 문제에 적용하는 방법까지 설명합니다.',
    }[mode];
}
function renderWritingModel() {
    const selected = modelOptions.some(option => option.value === form.writingModel) ? form.writingModel : DEFAULT_WRITING_MODEL;
    for (const option of modelOptions) option.setAttribute('aria-selected', String(option.value === selected));
    const selectedOption = modelOptions.find(option => option.value === selected);
    el('writing-model-value').textContent = selectedOption.textContent;
    const paidOnly = selectedOption.dataset.paidOnly === 'true';
    el('writing-model-help').hidden = !paidOnly;
    if (paidOnly) el('writing-model').setAttribute('aria-describedby', 'writing-model-help');
    else el('writing-model').removeAttribute('aria-describedby');
    el('writing-model').disabled = model.editable === false || !!model.pending || !!model.running;
    if (el('writing-model').disabled) closeModelOptions();
}
function closeModelOptions(restoreFocus = false) {
    el('writing-model-options').hidden = true;
    el('writing-model').setAttribute('aria-expanded', 'false');
    if (restoreFocus) el('writing-model').focus();
}
function openModelOptions() {
    if (el('writing-model').disabled) return;
    el('writing-model-options').hidden = false;
    el('writing-model').setAttribute('aria-expanded', 'true');
    modelOptions.find(option => option.getAttribute('aria-selected') === 'true').focus();
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
            ? '변경사항 메모를 그대로 사용하거나 자유롭게 고쳐보세요.'
            : '변경사항을 요약해 주세요.');
    el('progress-box').hidden = !model.pending && !model.running && !/저장|복사|적용|취소/.test(model.status || '');
    el('error-box').hidden = !model.error;
    el('error-text').textContent = model.error || '';
    el('cancel-btn').hidden = !model.pending;
    el('discard-pending-btn').hidden = !!model.running;
    el('candidate-box').hidden = !model.candidate;
    el('preparing').hidden = !!form.plan || busy;
    el('prepare-empty-btn').hidden = !!model.pending || !!model.running || !!model.candidate;
    el('preparing').querySelector('p').textContent = model.error
        ? '안내를 확인한 뒤 다시 시도할 수 있어요.'
        : '코드의 변경사항을 순서대로 정리해 드릴게요.';
    el('plan-content').hidden = !form.plan;
    el('generate-btn').disabled = !form.plan || model.pending;
    el('generate-btn').textContent = model.pending
        ? (model.pendingKind === 'prepare_blog' || !form.plan ? '준비 중…' : '작성 중…')
        : form.markdown ? '글 다시 쓰기' : '이대로 글쓰기';
    el('prepare-btn').disabled = model.pending;
    el('retry-btn').disabled = model.running;
    value('instructions', form.instructions);
    renderWritingMode();
    el('writing-mode').disabled = !editable;
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
    renderWritingModel();
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
        for (const key of ['plan', 'instructions', 'writingModel', 'writingMode', 'writingStyle', 'customStyle', 'title', 'markdown', 'document']) {
            if (!dirty.has(key)) form[key] = structuredClone(message[key]);
        }
        if (!recoveryApplied) {
            recoveryApplied = true;
            if (recovered?.filePath === model.filePath && recovered.fields && Object.keys(recovered.fields).length) {
                if (model.editable === false || (recovered.editToken && recovered.editToken !== model.editToken)) localRecovery ||= recovered.fields;
                else {
                    for (const [key, val] of Object.entries(recovered.fields)) {
                        if (['plan', 'instructions', 'writingModel', 'writingMode', 'writingStyle', 'customStyle', 'title', 'markdown', 'document'].includes(key)) {
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
el('writing-mode').addEventListener('change', (event) => {
    form.writingMode = event.target.value;
    changed('writingMode');
    renderWritingMode();
});
el('writing-model').addEventListener('click', () => {
    if (el('writing-model-options').hidden) openModelOptions();
    else closeModelOptions();
});
el('writing-model').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openModelOptions(); }
});
for (const option of modelOptions) {
    option.addEventListener('click', () => {
        if (el('writing-model').disabled) return;
        if (form.writingModel !== option.value) {
            form.writingModel = option.value;
            changed('writingModel');
            render();
        }
        closeModelOptions(true);
    });
}
el('writing-model-options').addEventListener('keydown', event => {
    const index = modelOptions.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % modelOptions.length;
    else if (event.key === 'ArrowUp') next = (index + modelOptions.length - 1) % modelOptions.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = modelOptions.length - 1;
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeModelOptions(true); }
    else if (event.key === 'Tab') closeModelOptions(true);
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const match = modelOptions.findIndex(option => option.textContent.toLowerCase().startsWith(event.key.toLowerCase()));
        if (match >= 0) next = match;
    }
    if (next !== undefined) { event.preventDefault(); modelOptions[next].focus(); }
});
document.addEventListener('pointerdown', event => {
    if (!el('model-select').contains(event.target)) closeModelOptions();
});
el('model-select').addEventListener('focusout', event => {
    if (!el('model-select').contains(event.relatedTarget)) closeModelOptions();
});
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
    ['recharge-credits-btn', 'rechargeCredits'],
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
