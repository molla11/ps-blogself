import * as crypto from 'crypto';
import { SnapshotDiff } from './types';

export function getHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

export function generateUUID(): string {
    return crypto.randomUUID();
}

/**
 * Computes a diff between oldText and newText.
 * Returns a SnapshotDiff if the change is a single contiguous block
 * and the changed content length is <= 100 characters.
 * Returns null if full snapshot is preferred.
 */
export function computeDiff(oldText: string, newText: string): SnapshotDiff | null {
    // Constraint: if total length <= 200, always save full snapshot
    if (newText.length <= 200) {
        return null;
    }

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

    const changedContent = newText.substring(start, endNew);

    // Constraint: diff content length <= 100
    if (changedContent.length > 100) {
        return null;
    }

    return {
        start,
        end: endOld, // valid until index in old text
        newText: changedContent,
    };
}
