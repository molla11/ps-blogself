import type { SnapshotTrigger } from '../types';

/** Coalesce background edits, but keep explicit checkpoints independent. */
export class BackgroundRecorder<T> {
    private pending = new Map<string, { value: T; idle: NodeJS.Timeout; deadline: NodeJS.Timeout }>();

    constructor(private readonly record: (value: T, reason: SnapshotTrigger) => Promise<void>) {}

    change(key: string, value: T) {
        const previous = this.pending.get(key);
        if (previous) clearTimeout(previous.idle);
        this.pending.set(key, {
            value,
            idle: setTimeout(() => void this.flush(key, 'idle'), 10_000),
            deadline: previous?.deadline ?? setTimeout(() => void this.flush(key, 'deadline'), 30_000),
        });
    }

    cancel(key: string) {
        const pending = this.pending.get(key);
        if (!pending) return;
        clearTimeout(pending.idle);
        clearTimeout(pending.deadline);
        this.pending.delete(key);
        return pending.value;
    }

    checkpoint(key: string, value: T, reason: SnapshotTrigger = 'save') {
        this.cancel(key);
        return this.record(value, reason);
    }

    async flush(key: string, reason: SnapshotTrigger = 'review') {
        const value = this.cancel(key);
        if (value !== undefined) await this.record(value, reason);
    }

    async flushAll(reason: SnapshotTrigger = 'close') {
        const writes: Promise<void>[] = [];
        for (const key of this.pending.keys()) {
            writes.push(this.flush(key, reason));
        }
        await Promise.all(writes);
    }

    discardWhere(matches: (value: T) => boolean) {
        for (const [key, { value }] of this.pending) if (matches(value)) this.cancel(key);
    }
}
