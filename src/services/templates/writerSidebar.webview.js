// The editor owns unsaved inputs, version previews and paid-model checks.
// Both surfaces invoke its controls so a sidebar action includes the latest edits.
export function connectWriterSidebar(vscode, currentModel) {
    const el = id => document.getElementById(id);
    let linked = false, queued = false, previous = '';
    const selectState = id => {
        const select = el(id);
        return { value: select.value, disabled: select.disabled,
            options: Array.from(select.options, option => [option.value, option.textContent]) };
    };
    const sourceButtons = {
        plan: 'plan-tab', article: 'article-tab', generate: 'generate-btn', preview: 'preview-btn', restore: 'restore-version-btn',
    };
    const selects = { mode: 'writing-mode', style: 'writing-style', version: 'version-select' };
    const prepareButton = () => el('plan-content').hidden ? el('prepare-empty-btn') : el('prepare-btn');
    function update() {
        if (!linked || queued || !currentModel()) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            if (!linked) return;
            const options = [...el('writing-model-options').querySelectorAll('[role=option]')];
            const prepare = prepareButton();
            const controls = {
                tab: el('plan-view').hidden ? 'article' : 'plan',
                articleDisabled: el('article-tab').disabled,
                generateLabel: el('generate-label').textContent,
                generateDisabled: el('generate-btn').disabled,
                hasPlan: !el('plan-content').hidden,
                prepareLabel: currentModel().pendingKind === 'prepare_blog' ? '메모 생성 중…' : prepare.textContent.trim(),
                prepareDisabled: prepare.disabled || prepare.hidden || (el('preparing').hidden && el('plan-content').hidden),
                model: { value: options.find(option => option.getAttribute('aria-selected') === 'true')?.value,
                    options: options.map(option => [option.value, option.textContent]), disabled: el('writing-model').disabled },
                modelHint: [el('writing-model-help').hidden ? '' : el('writing-model-help').textContent,
                    el('writing-model-hint').textContent].filter(Boolean).join(' '),
                mode: selectState('writing-mode'), style: selectState('writing-style'), modeHint: el('writing-mode-help').textContent,
                version: selectState('version-select'), restoreHidden: el('restore-version-btn').hidden,
                restoreDisabled: el('restore-version-btn').disabled, previewHidden: el('preview-btn').hidden,
                previewLabel: el('preview-btn').textContent,
            };
            const key = JSON.stringify(controls);
            if (key === previous) return;
            previous = key;
            vscode.postMessage({ type: 'writerControls', controls });
        });
    }
    window.addEventListener('message', ({ data }) => {
        if (data.type === 'writerSidebar') {
            linked = data.linked === true;
            document.body.classList.toggle('with-writer-sidebar', linked);
            previous = '';
            update();
        }
        if (data.type !== 'writerAction' || !linked || data.filePath !== currentModel()?.filePath) return;
        const { action, value } = data;
        if (action === 'model') {
            const option = [...el('writing-model-options').querySelectorAll('[role=option]')].find(option => option.value === value);
            if (!el('writing-model').disabled) option?.click();
        } else if (Object.hasOwn(selects, action)) {
            const select = el(selects[action]);
            if (!select.disabled && [...select.options].some(option => option.value === value)) {
                select.value = value;
                select.dispatchEvent(new Event('change'));
            }
        } else {
            const button = action === 'prepare' ? prepareButton() : Object.hasOwn(sourceButtons, action) && el(sourceButtons[action]);
            if (button && !button.disabled && !button.hidden) button.click();
        }
        update();
    });
    return update;
}
