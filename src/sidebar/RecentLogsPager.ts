import { SessionIndexItem } from '../types';

const PAGE_SIZE = 20;

/** Expands a live, newest-first index without offset gaps when files move. */
export class RecentLogsPager {
    private _search = { id: 0, query: '', limit: PAGE_SIZE, visiblePaths: new Set<string>() };
    private _revision = 0;
    private _queue: Promise<void> = Promise.resolve();

    constructor(private readonly _read: () => Promise<SessionIndexItem[]>) {}

    public get searchId() { return this._search.id; }

    public setSearch(query: string, id: number) {
        if (id <= this._search.id) return;
        this._search = { id, query: query.trim(), limit: PAGE_SIZE, visiblePaths: new Set<string>() };
    }

    public load(moreAfter?: number) {
        // Capture the search so an in-flight read cannot expand a later query's page.
        const search = this._search;
        const read = this._queue.then(async () => {
            const index = await this._read();
            const query = search.query.normalize('NFC').toLowerCase();
            // A separator opts into path matching. Compare Windows and POSIX
            // separators alike without depending on the extension host's OS.
            const pathQuery = /[\\/]/.test(query) ? query.replace(/\\/g, '/') : null;
            const logs = query ? index.filter(log =>
                log.fileName.normalize('NFC').toLowerCase().includes(query)
                || (pathQuery !== null && log.filePath.normalize('NFC').toLowerCase().replace(/\\/g, '/').includes(pathQuery)),
            ) : index;
            // Repeated requests for the same page are idempotent.
            let limit = search.limit;
            if (Number.isInteger(moreAfter) && moreAfter! >= 0 && moreAfter! <= limit) {
                limit = Math.max(limit, moreAfter! + PAGE_SIZE);
            }
            // New entries and reordered files must not evict already loaded rows.
            logs.forEach((log, index) => {
                if (search.visiblePaths.has(log.filePath)) limit = Math.max(limit, index + 1);
            });
            const recentLogs = logs.slice(0, limit);
            search.limit = limit;
            search.visiblePaths = new Set(recentLogs.map(log => log.filePath));
            return {
                recentLogs,
                hasMoreRecentLogs: recentLogs.length < logs.length,
                recentLogsRevision: ++this._revision,
                recentLogsSearchId: search.id,
            };
        });
        // Serialize reads so a delayed refresh cannot replace a newer index.
        this._queue = read.then(() => {}, () => {});
        return read;
    }
}
