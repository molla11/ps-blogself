// The editor owns unsaved inputs, version previews and paid-model checks.
// Both surfaces invoke its controls so a sidebar action includes the latest edits.
export function connectWriterSidebar(vscode, currentModel, selectEditorMode) {
    const el = id => document.getElementById(id);
    let linked = false, queued = false, previous = '';
    const selectState = id => {
        const select = el(id);
        return { value: select.value, disabled: select.disabled,
            options: Array.from(select.options, option => [option.value, option.textContent]) };
    };
    const sourceButtons = {
        plan: 'plan-tab', article: 'article-tab', generate: 'generate-btn', cancelWrite: 'cancel-write-btn', restore: 'restore-version-btn',
        viewSyncFailures: 'view-sync-failures', older: 'version-older-btn', newer: 'version-newer-btn',
    };
    const noticeIds = ['ownership-box', 'recovery-box', 'progress-box', 'error-box', 'candidate-box'];
    const forwarded = new Map([...noticeIds.map(el), el('export-menu')]
        .flatMap(group => [...group.querySelectorAll('button')].map(button => [button.id, button])));
    function buttons(group) {
        return [...group.querySelectorAll('button:not([hidden])')].map(button => ({
            action: button.id, label: button.getAttribute('aria-label') || button.textContent.trim(), disabled: button.disabled,
        }));
    }
    const selects = { mode: 'writing-mode', style: 'writing-style', version: 'version-select' };
    const prepareButton = () => el('plan-content').hidden ? el('prepare-empty-btn') : el('prepare-btn');
    // The contest switches can occupy the VS Code sidebar while local writing is allowed.
    const drawer = el('local-writer-tools'), opener = el('open-writer-sidebar');
    const positions = new Map();
    function useLocalDrawer(local) {
        if (local === (positions.size > 0)) return;
        if (local) {
            for (const id of ['writing-header', 'contest-backend-notice', ...noticeIds, 'article-toolbar', 'article-outline']) {
                const node = el(id), position = document.createComment(id);
                node.before(position);
                positions.set(node, position);
                drawer.append(node);
            }
        } else {
            drawer.hidePopover();
            for (const [node, position] of positions) position.replaceWith(node);
            positions.clear();
        }
        document.body.classList.toggle('with-local-writer-tools', local);
    }
    opener.addEventListener('click', () => {
        if (positions.size) drawer.showPopover({ source: opener });
        else vscode.postMessage({ type: 'openWriterSidebar' });
    });
    function update() {
        if (!linked || queued || !currentModel()) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            if (!linked) return;
            const options = [...el('writing-model-options').querySelectorAll('[role=option]')];
            const prepare = prepareButton();
            const notices = noticeIds.filter(id => !el(id).hidden).map(id => ({
                id, text: el(id).querySelector('span')?.textContent || '', actions: buttons(el(id)),
            }));
            const controls = {
                tab: el('plan-view').hidden ? 'article' : 'plan',
                articleDisabled: el('article-tab').disabled,
                generateLabel: el('generate-label').textContent,
                generateDisabled: el('generate-btn').disabled,
                showCancelWrite: !el('cancel-write-btn').hidden,
                hasPlan: !el('plan-content').hidden,
                prepareLabel: currentModel().pendingKind === 'prepare_blog' ? '메모 생성 중…' : prepare.textContent.trim(),
                prepareDisabled: prepare.disabled || prepare.hidden || (el('preparing').hidden && el('plan-content').hidden),
                model: { value: options.find(option => option.getAttribute('aria-selected') === 'true')?.value,
                    options: options.map(option => [option.value, option.textContent]), disabled: el('writing-model').disabled },
                modelHint: [el('writing-model-help').hidden ? '' : el('writing-model-help').textContent,
                    el('writing-model-hint').textContent].filter(Boolean).join(' '),
                mode: selectState('writing-mode'), style: selectState('writing-style'), modeHint: el('writing-mode-help').textContent,
                version: selectState('version-select'), restoreHidden: el('restore-version-btn').hidden,
                restoreDisabled: el('restore-version-btn').disabled, versionsHidden: el('versions-box').hidden,
                olderDisabled: el('version-older-btn').disabled, newerDisabled: el('version-newer-btn').disabled,
                browsingVersion: !!el('version-select').value,
                showEditorModes: !el('source-btn').hidden,
                editorMode: el('preview-btn').getAttribute('aria-pressed') === 'true' ? 'preview'
                    : el('source-btn').getAttribute('aria-pressed') === 'true' ? 'source' : 'edit',
                headings: [...el('outline-list').children].map(button => [button.dataset.level, button.textContent]),
                exports: buttons(el('export-menu')), ghostStatus: el('ghost-status').hidden ? '' : el('ghost-status').textContent,
                saveStatus: el('save-status').textContent, syncStatus: el('sync-status').textContent,
                hasSyncFailures: !el('view-sync-failures').hidden, notices,
            };
            const key = JSON.stringify(controls);
            if (key === previous) return;
            previous = key;
            vscode.postMessage({ type: 'writerControls', controls });
        });
    }
    // Saves, Ghost updates and outline edits can arrive independently of the document model.
    const observer = new MutationObserver(update);
    for (const id of ['save-status', 'sync-status', 'view-sync-failures', 'ghost-status', 'export-menu', 'outline-list', ...noticeIds]) {
        observer.observe(el(id), { childList: true, subtree: true, attributes: true, characterData: true });
    }
    window.addEventListener('message', ({ data }) => {
        if (data.type === 'writerSidebar') {
            linked = data.linked === true;
            useLocalDrawer(!linked && data.available === false);
            document.body.classList.toggle('with-writer-sidebar', linked || data.available === true);
            opener.hidden = linked || data.available === undefined;
            previous = '';
            update();
        }
        if (data.type !== 'writerAction' || !linked || data.filePath !== currentModel()?.filePath) return;
        const { action, value } = data;
        if (action === 'model') {
            const option = [...el('writing-model-options').querySelectorAll('[role=option]')].find(option => option.value === value);
            if (!el('writing-model').disabled) option?.click();
        } else if (['edit', 'source', 'preview'].includes(action)) {
            if (!el('article-view').hidden && !el('version-select').value) selectEditorMode(action);
        } else if (action === 'heading') {
            if (!el('article-view').hidden && !el('outline-toggle').disabled && /^\d+$/.test(value)) {
                el('outline-list').children[Number(value)]?.click();
            }
        } else if (Object.hasOwn(selects, action)) {
            const select = el(selects[action]);
            if (!select.disabled && [...select.options].some(option => option.value === value)) {
                select.value = value;
                select.dispatchEvent(new Event('change'));
            }
        } else {
            const button = forwarded.get(action) || (action === 'prepare' ? prepareButton() : Object.hasOwn(sourceButtons, action) && el(sourceButtons[action]));
            if (button && !button.disabled && !button.closest('[hidden]')) button.click();
        }
        update();
    });
    return update;
}
