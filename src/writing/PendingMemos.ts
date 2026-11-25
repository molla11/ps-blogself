import { randomUUID } from 'node:crypto';
import { atomicWrite, readJson, withFileLock } from '../storage/SharedFiles';

/** Record only pending file names. A window may acknowledge only the version of work it saw. */
export class PendingMemos {
    private tickets = new Map<string, string>();
    private writes: Promise<void> = Promise.resolve();
    constructor(private path: string, private onError: (error: unknown) => void) {}

    async restore() {
        const stored = await readJson<[string, string][]>(this.path) ?? [];
        this.tickets = new Map(stored);
        return [...this.tickets.keys()];
    }

    mark(file: string) {
        const ticket = randomUUID();
        this.tickets.set(file, ticket);
        this.update(records => { records.set(file, ticket); });
    }

    finish(file: string) {
        const ticket = this.tickets.get(file);
        if (!ticket) return;
        this.tickets.delete(file);
        this.update(records => { if (records.get(file) === ticket) records.delete(file); });
    }

    private update(change: (records: Map<string, string>) => void) {
        this.writes = withFileLock(this.path, async () => {
            const records = new Map(await readJson<[string, string][]>(this.path) ?? []);
            change(records);
            await atomicWrite(this.path, [...records]);
        }).catch(this.onError);
    }

    flush() { return this.writes; }
}
