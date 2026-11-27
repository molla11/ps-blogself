export function bindWriterTools(vscode, onFileChange, onFold) {
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
    function renderButtons(container, actions) {
        for (const node of [...container.children]) {
            if (!actions.some(item => item.action === node.dataset.writerAction)) node.remove();
        }
        actions.forEach(({ action, label, disabled }, index) => {
            let node = container.children[index];
            if (node?.dataset.writerAction !== action) {
                const next = document.createElement('button');
                next.type = 'button';
                next.className = 'secondary';
                next.dataset.writerAction = action;
                container.insertBefore(next, node || null);
                node = next;
            }
            if (node.textContent !== label) node.textContent = label;
            node.disabled = disabled;
        });
    }
    function renderNotices(notices) {
        const container = el('side-writer-notices');
        for (const node of [...container.children]) {
            if (!notices.some(notice => node.id === 'side-' + notice.id)) node.remove();
        }
        notices.forEach(({ id, text, actions }, index) => {
            let notice = el('side-' + id);
            if (!notice) {
                notice = document.createElement('div');
                notice.id = 'side-' + id;
                notice.className = 'writer-notice';
                const message = document.createElement('p');
                message.setAttribute('role', id === 'error-box' ? 'alert' : 'status');
                notice.append(message, document.createElement('div'));
                container.insertBefore(notice, container.children[index] || null);
            }
            if (notice.firstChild.textContent !== text) notice.firstChild.textContent = text;
            notice.firstChild.hidden = !text;
            renderButtons(notice.lastChild, actions);
        });
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
        send(action, target.dataset.value);
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
    return (writer, historyFile) => {
        const previousFile = filePath;
        filePath = writer?.filePath || historyFile;
        contextual = !!filePath;
        main.classList.toggle('writing', !!writer);
        main.classList.toggle('history', !writer && !!historyFile);
        main.classList.toggle('context-library', contextual);
        tools.hidden = !writer;
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
        selectTab(plan);
        button('article').disabled = c.articleDisabled;
        for (const key of ['model', 'mode', 'style', 'version']) field(key, c[key]);
        el('side-mode-hint').textContent = c.modeHint;
        el('side-model-hint').textContent = c.modelHint;
        el('side-model-hint').hidden = !c.modelHint;
        button('prepare').disabled = c.prepareDisabled;
        button('prepare').classList.toggle('secondary', c.hasPlan);
        button('prepare').textContent = c.prepareLabel;
        button('cancelWrite').hidden = !c.showCancelWrite;
        button('generate').hidden = c.showCancelWrite || (!c.hasPlan && plan);
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
        renderButtons(el('side-file-actions'), c.exports.filter(item => !item.action.startsWith('ghost-')));
        renderButtons(el('side-ghost-actions'), c.exports.filter(item => item.action.startsWith('ghost-')));
        button('viewSyncFailures').hidden = !c.hasSyncFailures;
        for (const [id, text] of [['side-sync-status', c.syncStatus || ''], ['side-save-status', c.saveStatus], ['side-ghost-status', c.ghostStatus]]) {
            const node = el(id);
            if (node.textContent !== text) node.textContent = text;
            node.hidden = !text;
        }
        renderNotices(c.notices);
    };
}
