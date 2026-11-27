import type { FileHistory, Snapshot, SnapshotDiff, SnapshotTrigger } from '../types';
import { getHash } from './utils';

const minute = 60_000;

export function sameBurst(history: FileHistory, last: Snapshot | undefined, session: string | undefined, time: number) {
    const prior = history.openEdit;
    return !!prior && !!last && prior.index === history.snapshots.length - 1 && prior.hash === last.hash
        && !last.checkpoints?.some(kind => kind !== 'save') && prior.session === session && time >= last.timestamp
        && time - last.timestamp < 2 * minute && time - prior.since < 5 * minute;
}

export function endsEditBatch(trigger?: SnapshotTrigger) {
    return !trigger || ['close', 'review', 'run', 'debug', 'task'].includes(trigger);
}

// A contiguous diff can span unchanged lines when two distant tokens were edited.
// Use net loss for block deletions and look for surviving lines before calling a rewrite destructive.
function isDestructive(before: string, after: string, edit: SnapshotDiff) {
    const removed = before.slice(edit.start, edit.end);
    if (!removed.trim()) return false;
    if (!after.trim()) return true;
    const removedLines = removed.split('\n').map(line => line.trim()).filter(Boolean);
    const addedLines = edit.newText.split('\n').map(line => line.trim()).filter(Boolean);
    if (removedLines.length - addedLines.length >= 3 || removed.trim().length - edit.newText.trim().length >= 100) return true;
    if (!edit.newText.trim() && /^[ \t]*(?:return|throw|break|continue|def|function|class|while|for|if)\b/m.test(removed)) {
        if (removed.includes('\n')) return true;
        const lineStart = before.lastIndexOf('\n', Math.max(0, edit.start - 1)) + 1;
        const nextLine = before.indexOf('\n', edit.end);
        if (!before.slice(lineStart, edit.start).trim() && !before.slice(edit.end, nextLine < 0 ? undefined : nextLine).trim()) return true;
    }
    if (removed.length < 80 || removed.length < before.length * 0.65 || removedLines.length < 3) return false;
    const survivingLines = new Set(addedLines.filter(line => /[\p{L}\d_]/u.test(line)));
    return !removedLines.some(line => survivingLines.has(line));
}

function startsNewStage(prior: NonNullable<FileHistory['openEdit']>, before: string, edit: SnapshotDiff, time: number) {
    const age = time - prior.since;
    if (age < minute) return false;
    const start = Math.min(prior.end, edit.end), end = Math.max(prior.start, edit.start);
    if (end > start && (end - start > 1_000 || before.slice(start, end).split('\n', 7).length === 7)) return true;
    if (age < 3 * minute) return false;
    return edit.newText.includes('\n') || before.slice(edit.start, edit.end).includes('\n')
        || /[;{}:)][ \t]*$/.test(edit.newText);
}

// Only the unreviewed tail is mutable. Record the latest edit's coordinates in the
// resulting document so the next capture can detect a jump to a different section.
export function nextEditBatch(history: FileHistory, last: Snapshot | undefined, before: string | null, after: string,
    edit: SnapshotDiff | null, session: string | undefined, trigger: SnapshotTrigger | undefined, time: number) {
    if (!session || endsEditBatch(trigger) || before === null || before === after || !edit || isDestructive(before, after, edit)) return;
    const prior = history.openEdit;
    const extend = prior && sameBurst(history, last, session, time) && !startsNewStage(prior, before, edit, time);
    const initialLength = extend ? prior.initialLength ?? before.length : before.length;
    // Many small backspaces can remove an existing block without one large diff.
    if (initialLength - after.length >= 160) return;
    const beforeInsertHash = edit.start === edit.end && edit.newText.length ? last?.hash ?? getHash(before) : undefined;
    return { session, initialLength, since: extend ? prior.since : time, count: extend ? prior.count + 1 : 1,
        start: edit.start, end: edit.start + edit.newText.length, beforeInsertHash };
}
