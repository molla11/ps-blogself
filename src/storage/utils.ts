import * as crypto from 'crypto';
import { SnapshotDiff } from '../types';

export function getHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

export function generateUUID(): string {
    return crypto.randomUUID();
}

/**
 * Computes a diff between oldText and newText.
 * Returns a SnapshotDiff if the change is a single contiguous block
 * and the inserted content fits within 5 lines and 500 UTF-8 bytes.
 * Returns null if full snapshot is preferred.
 */
export function computeDiff(oldText: string, newText: string): SnapshotDiff | null {
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

    // Constraint 1: <= 5 lines
    const lineCount = changedContent.split('\n').length;
    if (lineCount > 5) {
        return null;
    }

    // Constraint 2: <= 500 bytes
    const byteLength = Buffer.byteLength(changedContent, 'utf-8');
    if (byteLength > 500) {
        return null;
    }

    return {
        start,
        end: endOld, // valid until index in old text
        newText: changedContent,
    };
}
