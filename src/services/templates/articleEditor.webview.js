import React, { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal, flushSync } from 'react-dom';
import { LexicalExtensionComposer } from '@lexical/react/LexicalExtensionComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { DraggableBlockPlugin_EXPERIMENTAL } from '@lexical/react/LexicalDraggableBlockPlugin';
import { LexicalTypeaheadMenuPlugin, MenuOption, useBasicTypeaheadTriggerMatch } from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { RichTextExtension, $createHeadingNode, $createQuoteNode } from '@lexical/rich-text';
import { HistoryExtension } from '@lexical/history';
import { ListExtension, CheckListExtension, INSERT_UNORDERED_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND, INSERT_CHECK_LIST_COMMAND } from '@lexical/list';
import { LinkExtension, TOGGLE_LINK_COMMAND, $isLinkNode, $createLinkNode } from '@lexical/link';
import { CodeExtension, $createCodeNode, $isCodeNode } from '@lexical/code-core';
import { TableExtension, $createTableNodeWithDimensions } from '@lexical/table';
import { ClickAfterLastBlockExtension, SelectBlockExtension, TabIndentationExtension } from '@lexical/extension';
import { $setBlocksType } from '@lexical/selection';
import { defineExtension, configExtension, $getSelection, $setSelection, $isRangeSelection, $getRoot, $getNodeByKey, $getNearestNodeFromDOMNode, $createParagraphNode, $createNodeSelection, $createTextNode, $insertNodes, FORMAT_TEXT_COMMAND, UNDO_COMMAND, REDO_COMMAND, CLEAR_HISTORY_COMMAND, SKIP_SCROLL_INTO_VIEW_TAG, PASTE_COMMAND, DROP_COMMAND, COMMAND_PRIORITY_HIGH } from 'lexical';
import { documentFromMarkdown, documentMarkdown, validateDocument, safeArticleUrl } from '../../writing/ArticleDocument';
import { ArticleImageNode, ArticleDividerNode, $createArticleImageNode, setImageSources } from './articleNodes';
import { registerBlockDragging } from './blockDragging.js';

const h = React.createElement;
const extension = defineExtension({
    name: 'ps-blogself/article', namespace: 'ps-blogself/article',
    dependencies: [RichTextExtension, HistoryExtension, ListExtension, CheckListExtension, LinkExtension, CodeExtension, ClickAfterLastBlockExtension, SelectBlockExtension, TabIndentationExtension,
        configExtension(TableExtension, { hasCellMerge: false, hasCellBackgroundColor: false, hasHorizontalScroll: true, hasStickyScrollbar: false })],
    nodes: [ArticleImageNode, ArticleDividerNode],
    theme: { paragraph: 'article-paragraph', code: 'code-block', quote: 'article-quote', tableScrollableWrapper: 'table-wrapper',
        text: { bold: 'text-bold', italic: 'text-italic', strikethrough: 'text-strike', code: 'inline-code' },
        list: { checklist: 'task-list', listitemChecked: 'task-checked', listitemUnchecked: 'task-unchecked' } },
});
const icon = path => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons = { bullet: icon('<path d="M8 6h12M8 12h12M8 18h12M3 6h.1M3 12h.1M3 18h.1"/>'), ordered: icon('<path d="M9 6h12M9 12h12M9 18h12M2 4h1v4M1 11c4-3 4 1 0 3h4M1 17h3l-2 2h2v2H1"/>'), quote: icon('<path d="M4 5h6v7H4zM14 5h6v7h-6zM10 12c0 5-3 6-5 6M20 12c0 5-3 6-5 6"/>'), code: icon('<path d="m7 6-6 6 6 6m10-12 6 6-6 6M14 3l-4 18"/>'), link: icon('<path d="m9 15 6-6M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>'), image: icon('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m4 18 5-5 4 3 3-5 5 7"/>'), undo: icon('<path d="m9 4-5 5 5 5M4 9h10a6 6 0 0 1 0 12"/>'), redo: icon('<path d="m15 4 5 5-5 5M20 9H10a6 6 0 0 0 0 12"/>') };
const blocks = [['paragraph','본문'], ['heading','제목'], ['code','코드 블록'], ['list','글머리 목록'], ['ordered','번호 목록'], ['check','체크 목록'], ['quote','인용'], ['table','표'], ['image','이미지 주소 삽입'], ['file','이미지 파일 추가'], ['divider','구분선']];

export function createArticleEditor({ element, toolbar, outline, onChange, onOpenLink, onImageFile, onError }) {
    let editor, enabled = true, active = true, latestMarkdown = '', latestJSON = '', originalMarkdown = '', originalJSON = '', savedSelection;
    const tools = [];
    const el = id => document.getElementById(id);
    function doc() { return validateDocument({ version: 1, ...editor.getEditorState().toJSON() }); }
    function focus({ preventScroll = false } = {}) {
        if (!editor) return;
        editor.update(() => {
            if (savedSelection) { try { $setSelection(savedSelection.clone()); } catch {} }
            if (!$getSelection()) $getRoot().selectStart();
        }, { tag: SKIP_SCROLL_INTO_VIEW_TAG, discrete: true });
        editor.getRootElement()?.focus({ preventScroll });
    }
    function update(run) {
        if (!enabled || !active || !editor) return;
        focus({ preventScroll: true });
        editor.update(run, { discrete: true });
    }
    function blockAtSelection() {
        const selection = $getSelection();
        let node = $isRangeSelection(selection) ? selection.anchor.getNode() : selection?.getNodes()[0];
        if (!node) return null;
        while (node.getParent() && node.getParent().getType() !== 'root') node = node.getParent();
        return node;
    }
    function refreshTools() {
        if (!editor) return;
        editor.read(() => {
            const selection = $getSelection(), block = blockAtSelection();
            if (selection) savedSelection = selection.clone();
            for (const tool of tools) {
                tool.button.disabled = !enabled || !active;
                if (tool.mark) tool.button.setAttribute('aria-pressed', String($isRangeSelection(selection) && selection.hasFormat(tool.mark)));
            }
            el('block-type').value = block?.getType() === 'heading' ? block.getTag().slice(1) : 'paragraph';
            el('block-type').disabled = !enabled || !active;
            el('code-language').hidden = !active || !$isCodeNode(block);
            el('code-language').disabled = !enabled;
            if ($isCodeNode(block)) el('code-language').value = block.getLanguage() || '';
        });
    }
    function refreshOutline() {
        const headings = [...element.querySelectorAll('h1,h2,h3,h4,h5,h6')];
        const key = JSON.stringify(headings.map(node => [node.tagName, node.textContent]));
        if (outline.dataset.headings === key) return;
        outline.dataset.headings = key; outline.replaceChildren(); el('outline-empty').hidden = !!headings.length;
        headings.forEach((heading, index) => {
            const button = document.createElement('button'); button.className = 'outline-item'; button.textContent = heading.textContent || '제목 없음'; button.dataset.level = heading.tagName.slice(1);
            button.onclick = () => { const target = element.querySelectorAll('h1,h2,h3,h4,h5,h6')[index]; target?.scrollIntoView({ block: 'center' }); if (innerWidth < 700) el('outline-toggle').click(); };
            outline.appendChild(button);
        });
    }
    function insert(kind) {
        if (kind === 'image') { openUrl('image'); return; }
        if (kind === 'file') { pickImage(); return; }
        update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;
            switch (kind) {
                case 'heading': $setBlocksType(selection, () => $createHeadingNode('h2')); break;
                case 'code': $setBlocksType(selection, () => $createCodeNode('')); break;
                case 'quote': $setBlocksType(selection, () => $createQuoteNode()); break;
                case 'list': editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND); break;
                case 'ordered': editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND); break;
                case 'check': editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND); break;
                case 'table': $insertNodes([$createTableNodeWithDimensions(3, 2, true), $createParagraphNode()]); break;
                case 'divider': $insertNodes([new ArticleDividerNode(), $createParagraphNode()]); break;
                default: $setBlocksType(selection, () => $createParagraphNode());
            }
        });
    }
    async function importFile(file) {
        if (!enabled || !onImageFile) return;
        if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 10 * 1024 * 1024) { onError?.('PNG·JPEG·WebP·GIF 이미지를 10MB 이하로 추가해 주세요.'); return; }
        try {
            const result = await onImageFile(file);
            if (!enabled) return;
            if (result.preview) { currentImages = { ...currentImages, [result.src]: result.preview }; setImageSources(currentImages); }
            update(() => $insertNodes([$createArticleImageNode(result.src, file.name), $createParagraphNode()]));
        } catch (error) { onError?.(error.message); }
    }
    function pickImage() { const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp,image/gif'; input.onchange = () => { if (input.files?.[0]) void importFile(input.files[0]); }; input.click(); }
    function Bridge() {
        const [instance] = useLexicalComposerContext();
        useLayoutEffect(() => {
            editor = instance;
            const stop = editor.registerUpdateListener(({ tags, dirtyElements, dirtyLeaves }) => {
                refreshTools(); refreshOutline();
                if (tags.has('psb-load') || !dirtyElements.size && !dirtyLeaves.size) return;
                const document = doc(), json = JSON.stringify(document);
                if (json === latestJSON) return;
                latestJSON = json;
                latestMarkdown = json === originalJSON ? originalMarkdown : documentMarkdown(document);
                onChange(latestMarkdown, document);
            });
            const unpaste = editor.registerCommand(PASTE_COMMAND, event => {
                const file = [...(event?.clipboardData?.files || [])].find(file => file.type.startsWith('image/'));
                if (!file || !enabled) return false;
                event.preventDefault(); void importFile(file); return true;
            }, COMMAND_PRIORITY_HIGH);
            const undrop = editor.registerCommand(DROP_COMMAND, event => {
                const file = [...(event?.dataTransfer?.files || [])].find(file => file.type.startsWith('image/'));
                if (!file || !enabled) return false;
                event.preventDefault(); void importFile(file); return true;
            }, COMMAND_PRIORITY_HIGH);
            latestJSON = originalJSON = JSON.stringify(doc());
            return () => { stop(); unpaste(); undrop(); };
        }, [instance]);
        return null;
    }
    function DragHandles() {
        const menu = useRef(null), line = useRef(null), [target, setTarget] = useState(null);
        const [instance] = useLexicalComposerContext(), drag = useRef(null);
        useLayoutEffect(() => {
            drag.current = registerBlockDragging({ editor: instance, anchor: element, line: line.current, canDrag: () => enabled && active });
            return () => { drag.current.dispose(); drag.current = null; };
        }, [instance]);
        function selectTarget() { if (target) editor.update(() => { const node = $getNearestNodeFromDOMNode(target); if (!node) return; if (typeof node.selectEnd === 'function') node.selectEnd(); else { const selection = $createNodeSelection(); selection.add(node.getKey()); $setSelection(selection); } }, { discrete: true }); }
        return h(DraggableBlockPlugin_EXPERIMENTAL, {
            anchorElem: element, menuRef: menu, targetLineRef: line, onElementChanged: setTarget,
            isOnMenu: node => !!node.closest('.block-handle'),
            menuComponent: h('div', { ref: menu, className: 'block-handle', onDragStart: event => { event.preventDefault(); event.stopPropagation(); } },
                h('button', { className: 'quiet', title: '이 아래에 블록 추가', 'aria-label': '이 아래에 블록 추가', onMouseDown: e => e.preventDefault(), onClick: () => { if (!enabled) return; selectTarget(); update(() => { const block = blockAtSelection(); const node = $createParagraphNode(); block?.insertAfter(node); node.select(); }); el('insert-menu').showPopover(); } }, '+'),
                h('button', { className: 'quiet block-grip', title: '드래그하여 이동 · 클릭하여 블록 메뉴', 'aria-label': '블록 이동', draggable: true, onDragStart: event => drag.current?.start(event, target), onClick: () => { if (!enabled) return; selectTarget(); el('block-menu').showPopover(); } }, '⠿')),
            targetLineComponent: h('div', { ref: line, className: 'block-drop-line' }),
        });
    }
    function SlashMenu() {
        const [query, setQuery] = useState('');
        const trigger = useBasicTypeaheadTriggerMatch('/', { minLength: 0, allowWhitespace: true });
        const options = blocks.filter(([key, label]) => `${key} ${label}`.toLowerCase().includes((query || '').toLowerCase())).map(([key, label]) => Object.assign(new MenuOption(key), { label }));
        return h(LexicalTypeaheadMenuPlugin, {
            onQueryChange: setQuery, options,
            triggerFn: (value, lexical) => enabled && active ? trigger(value, lexical) : null,
            onSelectOption: (option, textNode, close) => { editor.update(() => textNode?.remove(), { discrete: true }); savedSelection = null; close(); insert(option.key); },
            menuRenderFn: (anchor, { selectedIndex, setHighlightedIndex, selectOptionAndCleanUp }) => anchor.current ? createPortal(
                h('div', { id: 'slash-menu', className: 'slash-menu', role: 'listbox', 'aria-label': '블록 선택' }, options.length ? options.map((option, index) => h('button', { key: option.key, ref: node => option.setRefElement(node), role: 'option', 'aria-selected': selectedIndex === index, onMouseDown: e => e.preventDefault(), onMouseEnter: () => setHighlightedIndex(index), onClick: () => selectOptionAndCleanUp(option) }, option.label)) : h('span', null, '일치하는 블록이 없습니다.')), anchor.current) : null,
        });
    }
    const root = createRoot(element);
    flushSync(() => root.render(h(LexicalExtensionComposer, { extension, contentEditable: null }, h(ContentEditable, { className: 'prose-editor', role: 'textbox', 'aria-label': '글 본문', 'aria-multiline': true, spellCheck: false }), h(Bridge), h(DragHandles), h(SlashMenu))));
    function tool(label, visual, command, mark) {
        const button = document.createElement('button'); button.className = 'format-tool'; button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.innerHTML = visual;
        button.onmousedown = event => event.preventDefault(); button.onclick = () => { if (enabled && active) command(); }; toolbar.appendChild(button); tools.push({ button, mark });
    }
    tool('굵게', '<b>B</b>', () => update(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')), 'bold');
    tool('기울임', '<i>I</i>', () => update(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')), 'italic');
    tool('글머리 목록', icons.bullet, () => insert('list')); tool('번호 목록', icons.ordered, () => insert('ordered'));
    tool('인용', icons.quote, () => insert('quote')); tool('코드 블록', icons.code, () => insert('code'));
    tool('링크', icons.link, () => openUrl('link')); tool('이미지 주소 삽입', icons.image, () => openUrl('image'));
    tool('실행 취소', icons.undo, () => { editor.dispatchCommand(UNDO_COMMAND); editor.getRootElement()?.focus({ preventScroll: true }); });
    tool('다시 실행', icons.redo, () => { editor.dispatchCommand(REDO_COMMAND); editor.getRootElement()?.focus({ preventScroll: true }); });
    el('block-type').onchange = event => update(() => { const selection = $getSelection(); if ($isRangeSelection(selection)) $setBlocksType(selection, () => event.target.value === 'paragraph' ? $createParagraphNode() : $createHeadingNode('h' + event.target.value)); });
    el('code-language').onchange = event => {
        const language = event.target.value;
        update(() => { const block = blockAtSelection(); if ($isCodeNode(block)) block.setLanguage(language); });
    };
    let urlKind = 'link', imageKey, imageSrc;
    const selectionTools = document.createElement('div'); selectionTools.className = 'selection-tools'; selectionTools.hidden = true; selectionTools.setAttribute('role', 'toolbar'); selectionTools.setAttribute('aria-label', '선택 영역 서식'); document.body.appendChild(selectionTools);
    for (const [label, visual, command] of [['선택 영역 굵게', '<b>B</b>', () => update(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold'))], ['선택 영역 기울임', '<i>I</i>', () => update(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic'))], ['선택 영역 링크', icons.link, () => openUrl('link')]]) { const button = document.createElement('button'); button.className = 'format-tool'; button.innerHTML = visual; button.setAttribute('aria-label', label); button.title = label; button.onmousedown = e => e.preventDefault(); button.onclick = command; selectionTools.appendChild(button); }
    function positionSelectionTools() {
        const selection = window.getSelection();
        selectionTools.hidden = !enabled || !active || !selection?.rangeCount || selection.isCollapsed || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode);
        if (selectionTools.hidden) return;
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        selectionTools.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - 50, innerWidth - 108)) + 'px';
        selectionTools.style.top = Math.max(8, rect.top - 40) + 'px';
    }
    document.addEventListener('selectionchange', positionSelectionTools); window.addEventListener('scroll', positionSelectionTools, { passive: true });
    const dialog = el('url-dialog'), input = el('insert-url');
    function openUrl(kind, image) {
        imageKey = image?.getKey(); imageSrc = image?.__src;
        urlKind = kind; el('url-dialog-title').textContent = kind === 'image' ? '이미지 주소 삽입' : '링크'; input.value = ''; input.setCustomValidity('');
        el('image-description-field').hidden = kind !== 'image'; el('image-description').value = ''; el('image-caption-field').hidden = kind !== 'image'; el('image-caption').value = '';
        el('remove-link-btn').hidden = true;
        editor.read(() => { const selection = $getSelection(); if ($isRangeSelection(selection)) { let node = selection.anchor.getNode(); if (!$isLinkNode(node)) node = node.getParent(); if ($isLinkNode(node)) { input.value = node.getURL(); el('remove-link-btn').hidden = kind !== 'link'; } } });
        input.disabled = kind === 'image' && !!imageSrc?.startsWith('psb-image:'); input.parentElement.hidden = input.disabled;
        if (image) { input.value = input.disabled ? '' : image.__src; el('image-description').value = image.__alt; el('image-caption').value = image.__caption; }
        dialog.showModal(); (input.disabled ? el('image-description') : input).focus();
    }
    input.oninput = () => input.setCustomValidity('');
    el('url-form').onsubmit = event => {
        event.preventDefault(); if (!enabled) { dialog.close(); return; }
        const url = input.disabled && imageSrc ? imageSrc : safeArticleUrl(input.value.trim(), urlKind === 'image');
        if (!url || url.startsWith('psb-image:') && !imageKey) { input.setCustomValidity(urlKind === 'image' ? 'https://로 시작하는 이미지 주소를 입력해 주세요.' : '올바른 링크 주소를 입력해 주세요.'); input.reportValidity(); return; }
        dialog.close();
        update(() => {
            if (urlKind === 'image') { const image = imageKey && $getNodeByKey(imageKey); if (image) image.setContent(url, el('image-description').value, el('image-caption').value); else $insertNodes([$createArticleImageNode(url, el('image-description').value, el('image-caption').value), $createParagraphNode()]); }
            else { const selection = $getSelection(); if ($isRangeSelection(selection) && selection.isCollapsed()) $insertNodes([$createLinkNode(url).append($createTextNode(url))]); else editor.dispatchCommand(TOGGLE_LINK_COMMAND, url); }
        });
    };
    el('close-url-btn').onclick = () => dialog.close();
    el('remove-link-btn').onclick = () => { dialog.close(); update(() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, null)); };
    element.addEventListener('click', event => { if (enabled && active && event.target.closest('.article-image')) { const node = editor.read(() => $getNearestNodeFromDOMNode(event.target.closest('.article-image'))); if (node) openUrl('image', node); return; } const link = event.target.closest('a'); if (link) { event.preventDefault(); if (!enabled || event.ctrlKey || event.metaKey) onOpenLink(link.href); } });
    el('insert-menu').replaceChildren(...blocks.map(([kind, label]) => { const button = document.createElement('button'); button.dataset.insert = kind; button.textContent = label; button.onclick = () => { el('insert-menu').hidePopover(); insert(kind); }; return button; }));
    for (const id of ['insert-menu', 'block-menu']) {el(id).addEventListener('beforetoggle', event => {
        if (event.newState !== 'open') return;
        const rect = (element.querySelector('.block-handle:hover') || el('insert-block-btn')).getBoundingClientRect();
        el(id).style.left = Math.max(8, Math.min(rect.left, innerWidth - 200)) + 'px';
        el(id).style.top = Math.max(8, Math.min(rect.bottom + 5, innerHeight - (id === 'insert-menu' ? 390 : 135))) + 'px';
    });}
    el('block-menu').querySelectorAll('[data-block-action]').forEach(button => button.onclick = () => {
        el('block-menu').hidePopover();
        update(() => { const block = blockAtSelection(); if (!block) return; const action = button.dataset.blockAction; if (action === 'delete') block.remove(); else { const sibling = action === 'up' ? block.getPreviousSibling() : block.getNextSibling(); if (sibling) { if (action === 'up') sibling.insertBefore(block); else sibling.insertAfter(block); } } });
    });
    let currentImages = {};
    return {
        setMarkdown(markdown = '', editable = true, document, images = {}) {
            enabled = editable; currentImages = { ...currentImages, ...images }; setImageSources(currentImages);
            const incoming = document && validateDocument(document);
            if (latestMarkdown !== markdown || incoming && JSON.stringify(incoming) !== latestJSON) {
                const state = incoming || documentFromMarkdown(markdown);
                editor.setEditorState(editor.parseEditorState({ root: state.root }), { tag: 'psb-load' });
                latestMarkdown = originalMarkdown = markdown;
                latestJSON = originalJSON = JSON.stringify(doc()); savedSelection = null;
                editor.dispatchCommand(CLEAR_HISTORY_COMMAND);
            }
            editor.setEditable(enabled); refreshTools(); refreshOutline();
            element.classList.toggle('read-only', !enabled); positionSelectionTools();
            element.querySelectorAll('.article-image img').forEach(img => { const node = editor.read(() => $getNearestNodeFromDOMNode(img)); const src = node?.__src; if (src && images[src] && img.src !== images[src]) img.src = images[src]; });
            if (!enabled && dialog.open) dialog.close();
        },
        setActive(value) { active = value; refreshTools(); positionSelectionTools(); }, focus,
        getDocument() { return doc(); },
    };
}
