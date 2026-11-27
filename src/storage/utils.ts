import * as crypto from 'crypto';
import { SnapshotDiff } from '../types';

export function getHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

export function generateUUID(): string {
    return crypto.randomUUID();
}

export function changedSpan(oldText: string, newText: string): SnapshotDiff {
    const n = oldText.length;
    const m = newText.length;
    let start = 0;

    // Find common prefix
    while (start < n && start < m && oldText[start] === newText[start]) {
        start++;
    }

    let endOld = n;
    let endNew = m;

    // Find common suffix
    // Ensure we don't overlap with the prefix
    while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
        endOld--;
        endNew--;
    }

    return { start, end: endOld, newText: newText.slice(start, endNew) };
}

/** Full versions and patches use the same change boundaries as edit grouping. */
export function compactDiff(edit: SnapshotDiff): SnapshotDiff | null {
    if (edit.newText.length > 500 || Buffer.byteLength(edit.newText, 'utf-8') > 500) return null;
    return edit.newText.split('\n').length <= 5 ? edit : null;
}

export function computeDiff(oldText: string, newText: string): SnapshotDiff | null {
    return compactDiff(changedSpan(oldText, newText));
}
