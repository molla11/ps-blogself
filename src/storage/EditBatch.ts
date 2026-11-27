import type { FileHistory, Snapshot, SnapshotDiff, SnapshotTrigger } from '../types';
import { getHash } from './utils';
import { isCosmeticChange } from '../writing/ChangeFilter';

function canCombine(edit: SnapshotDiff, before: string, after: string, language: string) {
    const { start, end, newText } = edit;
    if (start === end && newText.length === 0) return false;
    if (end - start > 240 || newText.length > 240 || newText.split('\n').length > 4) return false;
    if (end > start || !/\S/.test(newText)) {
        // Even one space can separate tokens, change Python indentation or be literal text.
        return before.length <= 16_384 && after.length <= 16_384
            && /^[ \t\r\n]*$/.test(before.slice(start, end)) && /^[ \t\r\n]*$/.test(newText)
            && isCosmeticChange(before, after, language);
    }
    if (/^[\p{P}\p{S}\d]+$/u.test(newText.trim())) return false;
    const nextLine = before.indexOf('\n', start);
    const suffix = before.slice(start, nextLine < 0 ? undefined : nextLine);
    return !suffix.trim() || /\n[ \t]*$/.test(newText) || /^[ \t]*[)\]},;]/.test(suffix);
}

export function sameBurst(history: FileHistory, last: Snapshot | undefined, session: string | undefined, time: number) {
    const prior = history.openEdit;
    return !!prior && !!last && prior.index === history.snapshots.length - 1 && prior.hash === last.hash
        && !last.checkpoints?.some(kind => kind !== 'save') && prior.session === session && time >= last.timestamp
        && time - last.timestamp <= 15_000 && time - prior.since <= 45_000;
}

export function endsEditBatch(trigger?: SnapshotTrigger) {
    // Delayed autosaves arrive as idle/deadline; 'autosave' is the focus-out checkpoint.
    return trigger !== 'save' && trigger !== 'idle' && trigger !== 'deadline';
}

// Only the tail may be amended. Its metadata describes the last edit in current
// coordinates, without keeping any intermediate code or reverse patches.
export function nextEditBatch(history: FileHistory, last: Snapshot | undefined, before: string | null, after: string,
    edit: SnapshotDiff | null, session: string | undefined, trigger: SnapshotTrigger | undefined, time: number) {
    if (!session || endsEditBatch(trigger) || before === null || !edit || !canCombine(edit, before, after, history.language)) return;
    const prior = history.openEdit;
    let since = time, count = 1;
    if (prior && prior.count < 8 && sameBurst(history, last, session, time)) {
        const from = Math.min(prior.end, edit.end), to = Math.max(prior.start, edit.start);
        if (to <= from || (to - from <= 24 && /^[ \t]*\r?\n?[ \t]*$/.test(before.slice(from, to)))) {
            since = prior.since;
            count = prior.count + 1;
        }
    }
    const beforeInsertHash = edit.start === edit.end && edit.newText.length ? last?.hash ?? getHash(before) : undefined;
    return { session, since, count, start: edit.start, end: edit.start + edit.newText.length, beforeInsertHash };
}
