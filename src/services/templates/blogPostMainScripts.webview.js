const vscode = acquireVsCodeApi();
const el = (id) => document.getElementById(id);
let model,
    form = {},
    counter = 0,
    activeTab = 'plan',
    lastMarkdown = '',
    editTimer,
    previewMode = false;
const dirty = new Set(),
    sent = new Map();
const recovered = vscode.getState();
let localRecovery = recovered?.localRecovery;
let recoveryApplied = false;
function height(node) {
    if (node.tagName === 'TEXTAREA' && !node.closest('[hidden]')) {
        node.style.height = 'auto';
        node.style.height = Math.max(70, node.scrollHeight + 2) + 'px';
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
    document.querySelectorAll('textarea').forEach(height);
}
function render() {
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
    el('error-box').hidden = !model.error;
    el('error-text').textContent = model.error || '';
    el('cancel-btn').hidden = !model.pending;
    el('progress').hidden = !model.running;
    el('progress').value = model.progress;
    el('discard-pending-btn').hidden = !model.pending || model.running;
    el('candidate-box').hidden = !model.candidate;
    el('preparing').hidden = !!form.plan;
    el('prepare-empty-btn').hidden = !!model.pending || !!model.running || !!model.candidate;
    el('preparing').querySelector('p').textContent = model.error
        ? '안내를 확인한 뒤 다시 시도할 수 있어요.'
        : '변경 구간과 풀이 설명을 먼저 채워드릴게요.';
    el('plan-content').hidden = !form.plan;
    el('generate-btn').disabled = !form.plan || model.pending;
    el('generate-btn').textContent = form.markdown ? '글 다시 쓰기' : '이대로 글쓰기';
    el('prepare-btn').disabled = model.pending;
    el('retry-btn').disabled = model.running;
    value('instructions', form.instructions);
    if (form.plan) {
        value('plan-title', form.plan.title);
        value('summary', form.plan.summary);
        range();
        renderSteps();
    }
    value('article-title', form.title);
    value('article-body', form.markdown);
    el('view-tabs').hidden = !form.markdown;
    if (form.markdown && !lastMarkdown) {
        switchTab('article');
        previewMode = true;
        send('preview', {}, true);
    } else if (form.markdown !== lastMarkdown && previewMode) {
        send('preview', {}, true);
    }
    lastMarkdown = form.markdown || '';
    if (!form.markdown) switchTab('plan');
    el('versions-box').hidden = !model.versions.length;
    const versions = el('versions');
    versions.replaceChildren();
    model.versions.forEach((version, index) => {
        const button = document.createElement('button');
        button.className = 'quiet';
        button.textContent = `${new Date(version.at).toLocaleString()} · ${version.title}`;
        button.disabled = !editable;
        button.addEventListener('click', () => send('restore', { index }, true));
        versions.appendChild(button);
    });
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
    if (message.type === 'model') {
        if (message.editable === false || (model?.editToken && message.editToken !== model.editToken)) {
            if (dirty.size) localRecovery = Object.fromEntries([...dirty].map(key => [key, structuredClone(form[key])]));
            dirty.clear(); sent.clear(); clearTimeout(editTimer);
        }
        model = message;
        for (const key of ['plan', 'instructions', 'title', 'markdown']) {
            if (!dirty.has(key)) form[key] = structuredClone(message[key]);
        }
        if (!recoveryApplied) {
            recoveryApplied = true;
            if (recovered?.filePath === model.filePath && recovered.fields && Object.keys(recovered.fields).length) {
                if (model.editable === false || (recovered.editToken && recovered.editToken !== model.editToken)) localRecovery ||= recovered.fields;
                else {
                    for (const [key, val] of Object.entries(recovered.fields)) {
                        if (['plan', 'instructions', 'title', 'markdown'].includes(key)) {
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
    } else if (message.type === 'saveError') {
        el('save-status').textContent = '저장 확인 필요';
    } else if (message.type === 'preview') {
        el('article-preview').innerHTML = message.html;
        el('article-preview').hidden = !previewMode;
        el('body-field').hidden = previewMode;
        el('preview-btn').textContent = previewMode ? '본문 수정' : '미리보기';
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
    ['article-title', 'title'],
    ['article-body', 'markdown'],
]) {
    el(id).addEventListener('input', (event) => {
        form[key] = event.target.value;
        height(event.target);
        changed(key);
    });
}
el('plan-title').addEventListener('input', (event) => {
    form.plan.title = event.target.value;
    changed('plan');
});
el('summary').addEventListener('input', (event) => {
    form.plan.summary = event.target.value;
    height(event.target);
    changed('plan');
});
el('prepare-empty-btn').addEventListener('click', () => send('prepare', {}, true));
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
    ['copy-btn', 'copy'],
    ['export-btn', 'export'],
    ['apply-candidate-btn', 'applyCandidate'],
]) {
    el(id).addEventListener('click', () => action(type));
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
    el('body-field').hidden = previewMode;
    el('article-preview').hidden = !previewMode;
    el('preview-btn').textContent = previewMode ? '본문 수정' : '미리보기';
    if (previewMode) action('preview');
    else {
        height(el('article-body'));
        el('article-body').focus();
    }
});
el('article-preview').addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (link) {
        event.preventDefault();
        send('openLink', { url: link.href });
    }
});
