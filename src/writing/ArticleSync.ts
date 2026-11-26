import { DraftStore } from './DraftStore';
import { backendRequests } from './BackendRequests';
import type { ServiceConnection } from './ServiceConnection';

/** Pending versions and the local edit are committed in the same draft file. */
export class ArticleSync {
    private files = new Set<string>();
    private active?: Promise<void>;
    private timer?: NodeJS.Timeout;
    private closed = false;
    constructor(private store: DraftStore, private connection: ServiceConnection) {}
    async start() {
        for (const file of await this.store.pendingFiles()) this.files.add(file);
        this.timer = setInterval(() => this.wake(), 30000);
        this.timer.unref();
        this.wake();
    }
    schedule(file: string) { this.files.add(file); this.wake(); }
    wake() {
        if (!this.closed && !this.active && this.files.size && backendRequests.enabled) {
            this.active = this.drain().catch(() => { /* Retry the durable queue on the next tick. */ })
                .finally(() => { this.active = undefined; });
        }
        return this.active;
    }
    private async drain() {
        const base = this.connection.base, owner = (await this.connection.saved(base))?.user.id;
        if (!owner) return;
        for (const file of [...this.files]) {
            if (this.closed || !backendRequests.enabled) return;
            this.files.delete(file);
            const ack = new Set<string>();
            try {
                for (const edit of await this.store.pendingEdits(file)) {
                    const { origin, id, ...body } = edit;
                    if (origin.base !== base || origin.owner !== owner) { this.files.add(file); continue; }
                    if (this.closed || !backendRequests.enabled || this.connection.base !== base) { this.files.add(file); break; }
                    try {
                        await this.connection.request('/jobs/' + encodeURIComponent(origin.jobId) + '/versions/' + encodeURIComponent(id),
                            'PUT', body, base, owner);
                    } catch (error) {
                        // Only an explicit deletion/missing parent is final. Older APIs also return generic 404s.
                        if ((error as {code?: string})?.code !== 'JOB_NOT_FOUND') throw error;
                    }
                    ack.add(id);
                }
            } catch { this.files.add(file); }
            if (ack.size) {
                try { await this.store.acknowledgeEdits(file, ack); } catch { this.files.add(file); }
            }
        }
    }
    async close() {
        this.closed = true;
        clearInterval(this.timer);
        await this.active;
    }
}
