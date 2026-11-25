/** Coalesce background edits, but keep explicit checkpoints independent. */
export class BackgroundRecorder<T> {
    private pending = new Map<string, { value: T; idle: NodeJS.Timeout; deadline: NodeJS.Timeout }>();

    constructor(private readonly record: (value: T) => Promise<void>) {}

    change(key: string, value: T) {
        const previous = this.pending.get(key);
        if (previous) clearTimeout(previous.idle);
        const flush = () => { void this.flush(key); };
        this.pending.set(key, {
            value,
            idle: setTimeout(flush, 10_000),
            deadline: previous?.deadline ?? setTimeout(flush, 30_000),
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

    checkpoint(key: string, value: T) {
        this.cancel(key);
        return this.record(value);
    }

    async flush(key: string) {
        const value = this.cancel(key);
        if (value !== undefined) await this.record(value);
    }

    async flushAll(matches: (value: T) => boolean = () => true) {
        const writes: Promise<void>[] = [];
        for (const [key, { value }] of this.pending) {
            if (matches(value)) writes.push(this.flush(key));
        }
        await Promise.all(writes);
    }

    discardWhere(matches: (value: T) => boolean) {
        for (const [key, { value }] of this.pending) if (matches(value)) this.cancel(key);
    }
}
