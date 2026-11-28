export function bindWriterTools(vscode, onFileChange, onFold, onHome) {
    const el = id => document.getElementById(id);
    const main = el('main-view'), tools = el('writer-tools'), library = el('file-library'), toggle = el('library-toggle');
    const button = key => tools.querySelector('button[data-writer-action="' + key + '"]');
    const roomy = window.matchMedia('(min-height: 600px)');
    const libraryChoices = new Map();
    let filePath, expanded = true, contextual = false;

    function expand(open) {
        if (!open && library.contains(document.activeElement)) toggle.focus();
        expanded = open;
        if (!open) onFold();
        library.inert = !open;
        toggle.setAttribute('aria-expanded', String(open));
        main.classList.toggle('library-open', open);
    }
    const expandForHeight = () => expand(!contextual || (libraryChoices.get(roomy.matches) ?? roomy.matches));
    roomy.addEventListener('change', expandForHeight);
    toggle.addEventListener('click', () => {
        libraryChoices.set(roomy.matches, !expanded);
        expand(!expanded);
    });
    function send(action, value) {
        if (filePath) vscode.postMessage({ type: 'writerAction', filePath, action, value });
    }
    const exportButtons = Array.from(el('side-export').querySelectorAll('button'), control => {
        const action = control.dataset.writerAction;
        const tip = document.createElement('span');
        tip.id = 'side-tip-' + action;
        tip.popover = 'hint';
        tip.setAttribute('role', 'tooltip');
        control.setAttribute('interestfor', tip.id);
        control.setAttribute('aria-labelledby', tip.id);
        control.after(tip);
        return { action, control, tip };
    });
    function renderExports(actions) {
        for (const { action, control, tip } of exportButtons) {
            const state = actions.find(item => item.action === action);
            control.hidden = !state;
            if (state) {
                if (tip.textContent !== state.label) tip.textContent = state.label;
                control.setAttribute('aria-disabled', String(state.disabled));
            } else if (tip.matches(':popover-open')) {
                tip.hidePopover();
            }
        }
    }
    function renderOutline(headings) {
        const list = el('side-outline-list'), key = JSON.stringify(headings);
        if (list.dataset.headings === key) return;
        list.dataset.headings = key;
        list.replaceChildren(...headings.map(([level, label], index) => {
            const node = document.createElement('button');
            node.type = 'button';
            node.dataset.writerAction = 'heading';
            node.dataset.value = String(index);
            node.dataset.level = level;
            node.textContent = node.title = label;
            return node;
        }));
        el('side-outline-empty').hidden = headings.length > 0;
    }
    tools.addEventListener('click', event => {
        const target = event.target.closest('button[data-writer-action]');
        if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
        send(target.dataset.writerAction, target.dataset.value);
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
    function render(writer, historyFile) {
        const previousFile = filePath;
        filePath = writer?.filePath || historyFile;
        contextual = !!filePath;
        main.classList.toggle('writing', !!writer);
        main.classList.toggle('history', !writer && !!historyFile);
        main.classList.toggle('context-library', contextual);
        tools.hidden = !writer;
        el('sidebar-home-btn').hidden = !contextual;
        toggle.hidden = !contextual;
        if (previousFile !== filePath) {
            for (const id of ['side-outline', 'side-export']) el(id).open = false;
            if (filePath) onFileChange(filePath);
            expandForHeight();
        }
        if (!writer) return;
        const c = writer.controls, plan = c.tab === 'plan';
        el('writer-file-name').textContent = writer.fileName;
        el('writer-file-name').title = filePath;
        el('writer-plan-options').hidden = !plan;
        el('writer-article-options').hidden = plan || !c.hasArticle;
        button('prepare').hidden = !plan;
        for (const key of ['model', 'mode', 'style', 'version']) field(key, c[key]);
        el('side-model-hint').textContent = c.modelHint;
        el('side-model-hint').hidden = !c.modelHint;
        button('prepare').disabled = c.prepareDisabled;
        button('prepare').classList.toggle('secondary', c.hasPlan);
        button('prepare').textContent = c.prepareLabel;
        button('cancelWrite').hidden = !c.showCancelWrite;
        button('generate').hidden = c.showCancelWrite || (plan ? !c.hasPlan : !c.hasArticle);
        button('generate').textContent = c.generateLabel;
        button('generate').disabled = c.generateDisabled;
        button('restore').hidden = c.restoreHidden;
        button('restore').disabled = c.restoreDisabled;
        el('side-history').hidden = c.versionsHidden;
        button('older').disabled = c.olderDisabled;
        button('newer').disabled = c.newerDisabled;
        el('side-view-modes').hidden = !c.showEditorModes;
        for (const mode of ['edit', 'source', 'preview']) button(mode).setAttribute('aria-pressed', String(c.editorMode === mode));
        el('side-outline').hidden = c.browsingVersion || c.editorMode !== 'edit';
        renderOutline(c.headings);
        renderExports(c.exports);
        button('viewSyncFailures').hidden = !c.hasSyncFailures;
        for (const [id, text] of [['side-sync-status', c.syncStatus || ''], ['side-save-status', c.saveStatus], ['side-ghost-status', c.ghostStatus]]) {
            const node = el(id);
            if (node.textContent !== text) node.textContent = text;
            node.hidden = !text;
        }
    }
    function showHome() {
        if (filePath) vscode.postMessage({ type: 'sidebarHome', context: tools.hidden ? 'history' : 'writer', filePath });
        render();
        onHome();
    }
    el('sidebar-home-btn').addEventListener('click', showHome);
    el('full-logs-back-btn').addEventListener('click', showHome);
    return render;
}
