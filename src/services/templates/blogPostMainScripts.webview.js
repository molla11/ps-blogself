const vscode = acquireVsCodeApi();
const snapshots = /* {{snapshotsJson}} */ [];
const draft = /* {{draftJson}} */ {};

// Elements
const timeline = document.getElementById('timeline');
const rangeInfo = document.getElementById('range-info');
const instructionsContainer = document.getElementById('instructions-container');
const toggleInstructionsBtn = document.getElementById('toggle-instructions-btn');
const instructionsTextarea = document.getElementById('instructions');
const generateBtn = document.getElementById('generate-btn');

// Initial UI state for instructions
if (draft.instructions && draft.instructions.trim() !== '') {
    instructionsContainer.classList.add('visible');
    toggleInstructionsBtn.textContent = '- 설명 숨기기';
} else {
    instructionsContainer.classList.remove('visible');
    toggleInstructionsBtn.textContent = '+ 설명 추가하기(Optional, 지문/풀이 설명, 문제 제한 등)';
}

// Event Listeners
toggleInstructionsBtn.addEventListener('click', () => {
    const isVisible = instructionsContainer.classList.contains('visible');
    if (isVisible) {
        instructionsContainer.classList.remove('visible');
        toggleInstructionsBtn.textContent =
            '+ 설명 추가하기(Optional, 지문/풀이 설명, 문제 제한 등)';
    } else {
        instructionsContainer.classList.add('visible');
        toggleInstructionsBtn.textContent = '- 설명 숨기기';
        instructionsTextarea.focus();
    }
});

// Toggle Diff Comment
document.querySelectorAll('.toggle-comment-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
        const index = e.currentTarget.dataset.index;
        const commentArea = document.getElementById('comment-area-' + index);
        if (commentArea) {
            const isVisible = commentArea.classList.contains('visible');
            if (isVisible) {
                commentArea.classList.remove('visible');
            } else {
                commentArea.classList.add('visible');
                // Focus textarea
                const textarea = commentArea.querySelector('textarea');
                if (textarea) textarea.focus();
            }
        }
    });
});

// Instructions
document.getElementById('instructions').addEventListener('input', (e) => {
    draft.instructions = e.target.value;
    saveDraft();
});

// Comments (Delegate for dynamic availability? No, diff list is static structure, just toggled display)
// Actually, Diff List is populated by _generateSelectableDiffsHtml (server side).
// We just hide/show them. So listeners can be attached on load.
document.querySelectorAll('.comment-input-area').forEach((area) => {
    area.addEventListener('input', (e) => {
        const index = parseInt(e.target.dataset.index);
        draft.diffComments[index] = e.target.value;
        saveDraft();
    });
});

// Buttons
document.getElementById('generate-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'saveDraft', draft });
    vscode.postMessage({ type: 'generate', draft });
});

function saveDraft() {
    vscode.postMessage({ type: 'saveDraft', draft: draft });
}

// Render Timeline
function renderTimeline() {
    // Remove existing dots
    document.querySelectorAll('.timeline-dot').forEach((e) => e.remove());

    const total = snapshots.length;
    if (total === 0) return;

    snapshots.forEach((snap, i) => {
        const dot = document.createElement('div');
        dot.className = 'timeline-dot';
        // Position based on index (even spacing for now)
        // padding 10px on sides means 20px total subtraction
        // but simplest is just percentage
        const left = (i / (total - 1)) * 100; // 0 to 100
        dot.style.left = `calc(10px + (100% - 20px) * ${left / 100})`;

        dot.dataset.index = i;

        // Tooltip
        const tooltip = document.createElement('div');
        tooltip.className = 'timeline-tooltip';
        const date = new Date(snap.timestamp);
        tooltip.textContent = `Diff #${i} (${date.toLocaleTimeString()})`;
        dot.appendChild(tooltip);

        // Events
        dot.addEventListener('mousedown', handleDotMouseDown);
        dot.addEventListener('mouseenter', handleDotHover);
        dot.addEventListener('mouseleave', handleDotLeave);

        timeline.appendChild(dot);
    });

    updateSelectionUI();
}

// Hover Logic
function handleDotHover(e) {
    if (isDragging) return; // Don't interfere if dragging? Or maybe we should? No, stick to drag.
    const index = parseInt(e.target.dataset.index);

    // Show ONLY this diff
    document.querySelectorAll('.diff-selection-root').forEach((el) => {
        const idx = parseInt(el.dataset.index);
        if (idx === index) {
            el.style.display = 'block';
            // Add a temporary highlight class if needed?
        } else {
            el.style.display = 'none';
        }
    });
}

function handleDotLeave(e) {
    if (isDragging) return;
    // Restore Selection View
    updateSelectionUI();
}

// Interaction Logic
let isDragging = false;
let dragTargetIndex = -1; // 0 for start, 1 for end
let tempIndices = [...draft.selectedChangeIndices];

function updateSelectionUI() {
    const indices = draft.selectedChangeIndices.sort((a, b) => a - b);

    // Update Dots
    document.querySelectorAll('.timeline-dot').forEach((dot) => {
        const idx = parseInt(dot.dataset.index);
        dot.classList.remove('active', 'in-range');
        if (indices.includes(idx)) {
            if (idx === indices[0] || idx === indices[indices.length - 1]) {
                dot.classList.add('active');
            } else {
                dot.classList.add('in-range');
            }
        }
    });

    // Update Range Bar
    if (indices.length > 0) {
        const startDot = document.querySelector(`.timeline-dot[data-index="${indices[0]}"]`);
        const endDot = document.querySelector(
            `.timeline-dot[data-index="${indices[indices.length - 1]}"]`,
        );
        if (startDot && endDot) {
            const rangeElem = document.getElementById('timeline-range');
            rangeElem.style.left = startDot.style.left;
            rangeElem.style.width = `calc(${endDot.style.left} - ${startDot.style.left})`;
            if (indices.length === 1) rangeElem.style.width = '0px';
        }
    } else {
        document.getElementById('timeline-range').style.width = '0px';
    }

    // Show/Hide Diffs
    document.querySelectorAll('.diff-selection-root').forEach((el) => {
        const idx = parseInt(el.dataset.index);
        if (indices.includes(idx)) {
            el.style.display = 'block';
        } else {
            el.style.display = 'none';
        }
    });

    // Calculate Payload Size
    // 1. Base Content Size
    const firstIndex = indices[0];
    let baseSize = 0;

    // Helper to get length at a specific index
    const getContentLength = (idx) => {
        if (idx < 0) return 0;
        // Find nearest full full snapshot <= idx
        let startIdx = -1;
        let len = 0;
        for (let i = idx; i >= 0; i--) {
            if (snapshots[i].content) {
                startIdx = i;
                len = snapshots[i].content.length;
                break;
            }
        }
        // If no full snapshot found, start from 0 (empty)
        if (startIdx === -1) {
            startIdx = -1;
            len = 0;
        }

        // Apply diffs forward
        for (let i = startIdx + 1; i <= idx; i++) {
            const d = snapshots[i].diff;
            if (d) {
                len = len - (d.end - d.start) + d.newText.length;
            } else if (snapshots[i].content) {
                // Should be handled by startIdx logic, but safeguard
                len = snapshots[i].content.length;
            }
        }
        return len;
    };

    if (firstIndex > 0) {
        baseSize = getContentLength(firstIndex - 1);
    }

    // 2. Selected Diffs Size
    let diffsSize = 0;
    indices.forEach((idx) => {
        const snap = snapshots[idx];
        if (snap.content) diffsSize += snap.content.length;
        else if (snap.diff) diffsSize += snap.diff.newText.length;
    });

    const totalSize = baseSize + diffsSize;

    const formatSize = (bytes) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };
    const sizeStr = formatSize(totalSize);
    // Optional: Show breakdown? "1.5 KB (Base: 1.0 KB)"
    // User requested to hide breakdown:
    // const fullSizeStr = `${sizeStr} (Base: ${formatSize(baseSize)})`;

    if (indices.length === 0) {
        rangeInfo.textContent = '타임라인에서 구간을 선택하세요';
    } else if (indices.length === 1) {
        rangeInfo.textContent = `Diff #${indices[0] + 1} 선택됨 (${sizeStr})`;
    } else {
        rangeInfo.textContent = `Diff #${indices[0] + 1}~${indices[indices.length - 1] + 1} 선택됨 (${sizeStr})`;
    }
}

function handleDotMouseDown(e) {
    e.stopPropagation();
    const index = parseInt(e.target.dataset.index);

    // Logic:
    // If no selection: start selection (start = end = index)
    // If 1 point selected (start=end): set end = index (or start if smaller)
    // If range selected:
    //   Check if clicking on start or end -> Drag Mode
    //   Else -> Reset and start new selection? Or expand?
    //   UX Request: "Click two points to select range", "Drag start/end points"

    const indices = draft.selectedChangeIndices.sort((a, b) => a - b);

    if (indices.length < 2 && (indices.length === 0 || indices[0] !== index)) {
        // Click to define range or start new
        if (indices.length === 1) {
            const start = Math.min(indices[0], index);
            const end = Math.max(indices[0], index);
            setRange(start, end);
        } else {
            setRange(index, index);
        }
    } else {
        // Check if clicking start or end to drag
        const start = indices[0];
        const end = indices[indices.length - 1];

        if (index === start || index === end) {
            enableDragNew(index);
        } else {
            // Clicking in middle or outside -> Start new selection
            setRange(index, index);
        }
    }
}

// Better Drag Logic:
// When drag starts, identify Anchor (the point that stays put).
// Drag Target is the other point.
let dragAnchorIndex = -1;

// Override enableDrag to set Anchor
function enableDragNew(clickedIndex) {
    const indices = draft.selectedChangeIndices.sort((a, b) => a - b);
    const start = indices[0];
    const end = indices[indices.length - 1];

    if (start === end) {
        dragAnchorIndex = -1; // Moving the whole selection (single point)
    } else if (clickedIndex === start) {
        dragAnchorIndex = end;
    } else {
        dragAnchorIndex = start;
    }

    isDragging = true;
    document.body.style.cursor = 'grabbing';
    document.addEventListener('mousemove', handleDragMoveNew);
    document.addEventListener('mouseup', handleDragEndNew);
}

function handleDragMoveNew(e) {
    if (!isDragging) return;
    const rect = timeline.getBoundingClientRect();
    const x = e.clientX - rect.left - 10;
    const effectiveWidth = rect.width - 20;
    let ratio = x / effectiveWidth;
    ratio = Math.max(0, Math.min(1, ratio));
    const total = snapshots.length;
    const newIndex = Math.round(ratio * (total - 1));

    if (dragAnchorIndex === -1) {
        // Moving single point
        setRange(newIndex, newIndex);
    } else {
        const s = Math.min(dragAnchorIndex, newIndex);
        const e = Math.max(dragAnchorIndex, newIndex);
        setRange(s, e);
    }
}

function handleDragEndNew() {
    isDragging = false;
    document.body.style.cursor = 'default';
    document.removeEventListener('mousemove', handleDragMoveNew);
    document.removeEventListener('mouseup', handleDragEndNew);
}

function setRange(start, end) {
    const newIndices = [];
    for (let i = start; i <= end; i++) {
        newIndices.push(i);
    }
    draft.selectedChangeIndices = newIndices;
    updateSelectionUI();
    saveDraft();
}

// Initialize
renderTimeline();
