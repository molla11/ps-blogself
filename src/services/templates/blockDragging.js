import { $getRoot, $getNodeByKey, $getNearestNodeFromDOMNode, $createNodeSelection, $setSelection, HISTORY_MERGE_TAG, HISTORY_PUSH_TAG, SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG } from 'lexical';

// Keep hover/handle placement in Lexical's plugin, but own the document's drop
// surface: its padding is outside contenteditable and must accept edge drops.
export function registerBlockDragging({ editor, anchor, line, canDrag }) {
    const surface = anchor.closest('.document-paper') || anchor;
    let draggedKey;
    const hideLine = () => { line.style.opacity = '0'; };
    const end = () => { draggedKey = undefined; hideLine(); };
    function start(event, element) {
        event.stopPropagation();
        if (!element || !event.dataTransfer || !canDrag() || !editor.isEditable()) {
            event.preventDefault(); return;
        }
        draggedKey = editor.read(() => {
            let node = $getNearestNodeFromDOMNode(element);
            while (node?.getParent() && node.getParent().getType() !== 'root') node = node.getParent();
            return node?.getParent()?.getType() === 'root' ? node.getKey() : undefined;
        });
        if (!draggedKey) { event.preventDefault(); return; }
        // Establish the pre-move selection/history even when dragging is the
        // first edit after opening a document. Do not focus/scroll during dragstart.
        editor.update(() => {
            const selection = $createNodeSelection(); selection.add(draggedKey); $setSelection(selection);
        }, { discrete: true, tag: [HISTORY_MERGE_TAG, SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG] });
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-psb-article-block', draggedKey);
        event.dataTransfer.setDragImage(element, 0, Math.max(0, event.clientY - element.getBoundingClientRect().top));
    }
    function destination(clientY) {
        return editor.read(() => {
            const blocks = $getRoot().getChildren().filter(node => node.getKey() !== draggedKey)
                .map(node => ({ key: node.getKey(), element: editor.getElementByKey(node.getKey()) }))
                .filter(block => block.element).map(block => ({ key: block.key, rect: block.element.getBoundingClientRect() }));
            const next = blocks.find(block => clientY < block.rect.top + block.rect.height / 2);
            if (next) return { key: next.key, before: true, y: next.rect.top };
            const last = blocks.at(-1);
            return last ? { key: last.key, before: false, y: last.rect.bottom } : undefined;
        });
    }
    function showLine(target) {
        const root = editor.getRootElement();
        if (!target || !root) { hideLine(); return; }
        const anchorRect = anchor.getBoundingClientRect(), rootRect = root.getBoundingClientRect();
        const scaleX = anchorRect.width / anchor.offsetWidth || 1, scaleY = anchorRect.height / anchor.offsetHeight || 1;
        line.style.transform = 'none';
        line.style.left = (rootRect.left - anchorRect.left) / scaleX + anchor.scrollLeft + 'px';
        line.style.top = (target.y - anchorRect.top) / scaleY + anchor.scrollTop - line.offsetHeight / 2 + 'px';
        line.style.width = rootRect.width / scaleX + 'px';
        line.style.opacity = '.4';
    }
    function over(event) {
        if (!draggedKey) return;
        event.preventDefault(); event.stopPropagation();
        if (!canDrag() || !editor.isEditable()) { hideLine(); return; }
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        // Both hit testing and the indicator use viewport coordinates, including
        // after scrolling during a drag. pageY would apply scroll offsets twice.
        showLine(destination(event.clientY));
    }
    function drop(event) {
        if (!draggedKey) return;
        event.preventDefault(); event.stopPropagation();
        const key = draggedKey, target = destination(event.clientY);
        end();
        if (!target || !canDrag() || !editor.isEditable()) return;
        editor.update(() => {
            const node = $getNodeByKey(key), neighbor = $getNodeByKey(target.key);
            if (node?.getParent() !== $getRoot() || neighbor?.getParent() !== $getRoot()) return;
            if (target.before) {
                if (node.getNextSibling() !== neighbor) neighbor.insertBefore(node);
            } else if (node.getPreviousSibling() !== neighbor) neighbor.insertAfter(node);
        }, { discrete: true, tag: [HISTORY_PUSH_TAG, SKIP_SCROLL_INTO_VIEW_TAG] });
    }
    function leave(event) {
        if (!surface.contains(event.relatedTarget)) hideLine();
    }
    // Capture internal block drops before contenteditable's text/file handlers.
    // External files/text have no active draggedKey and retain their normal path.
    surface.addEventListener('dragover', over, true);
    surface.addEventListener('drop', drop, true);
    surface.addEventListener('dragleave', leave);
    surface.addEventListener('dragend', end, true);
    const unregister = editor.registerEditableListener(editable => { if (!editable) end(); });
    return {
        start,
        dispose() {
            end(); unregister();
            surface.removeEventListener('dragover', over, true);
            surface.removeEventListener('drop', drop, true);
            surface.removeEventListener('dragleave', leave);
            surface.removeEventListener('dragend', end, true);
        },
    };
}
