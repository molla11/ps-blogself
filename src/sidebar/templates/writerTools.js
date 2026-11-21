export function bindWriterTools(vscode, onFileChange, onFold) {
    const el = id => document.getElementById(id);
    const main = el('main-view'), tools = el('writer-tools'), library = el('file-library'), toggle = el('library-toggle');
    const button = key => tools.querySelector('button[data-writer-action="' + key + '"]');
    let filePath, expanded = true;

    function expand(open) {
        if (!open && library.contains(document.activeElement)) toggle.focus();
        expanded = open;
        if (!open) onFold();
        library.inert = !open;
        toggle.setAttribute('aria-expanded', String(open));
        main.classList.toggle('library-open', open);
    }
    toggle.addEventListener('click', () => expand(!expanded));
    function send(action, value) {
        if (filePath) vscode.postMessage({ type: 'writerAction', filePath, action, value });
    }
    function selectTab(plan) {
        button('plan').setAttribute('aria-pressed', String(plan));
        button('article').setAttribute('aria-pressed', String(!plan));
        el('writer-plan-options').hidden = !plan;
        el('writer-article-options').hidden = plan;
        button('prepare').hidden = !plan;
    }
    tools.addEventListener('click', event => {
        const target = event.target.closest('button[data-writer-action]');
        if (!target || target.disabled) return;
        const action = target.dataset.writerAction;
        if (action === 'plan' || action === 'article') selectTab(action === 'plan');
        send(action);
    });
    tools.addEventListener('change', event => {
        const target = event.target.closest('select[data-writer-action]');
        if (target && !target.disabled) send(target.dataset.writerAction, target.value);
    });
    function field(key, state) {
        const select = el('side-' + key);
        const signature = JSON.stringify(state.options);
        if (select.dataset.options !== signature) {
            select.replaceChildren(...state.options.map(([value, label]) => new Option(label, value)));
            select.dataset.options = signature;
        }
        select.value = state.value;
        select.disabled = state.disabled || state.options.length < 2;
    }
    return writer => {
        const changedFile = filePath !== writer?.filePath;
        filePath = writer?.filePath;
        main.classList.toggle('writing', !!writer);
        tools.hidden = toggle.hidden = !writer;
        if (changedFile) {
            if (filePath) onFileChange(filePath);
            expand(!writer);
        }
        if (!writer) return;
        const c = writer.controls, plan = c.tab === 'plan';
        el('writer-file-name').textContent = writer.fileName;
        el('writer-file-name').title = filePath;
        selectTab(plan);
        button('article').disabled = c.articleDisabled;
        for (const key of ['model', 'mode', 'style', 'version']) field(key, c[key]);
        el('side-mode-hint').textContent = c.modeHint;
        el('side-model-hint').textContent = c.modelHint;
        el('side-model-hint').hidden = !c.modelHint;
        button('prepare').disabled = c.prepareDisabled;
        button('prepare').classList.toggle('secondary', c.hasPlan);
        button('prepare').textContent = c.prepareLabel;
        button('generate').hidden = !c.hasPlan && plan;
        button('generate').textContent = c.generateLabel;
        button('generate').disabled = c.generateDisabled;
        button('restore').hidden = c.restoreHidden;
        button('restore').disabled = c.restoreDisabled;
        button('preview').hidden = c.previewHidden;
        button('preview').textContent = c.previewLabel;
    };
}
