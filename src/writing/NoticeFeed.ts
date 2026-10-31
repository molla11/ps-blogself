import { createHash } from 'crypto';

export interface Notice { id: string; title: string; body: string; audience: 'all' | 'user'; createdAt: string; expiresAt: string | null }
interface Session { base: string; token?: string; owner?: string }
interface Storage { get<T>(key: string, fallback: T): T; update(key: string, value: unknown): PromiseLike<void> }
const identity = (s: Session) => JSON.stringify([s.base, s.owner, s.token]);
const storageKey = (s: Session) => 'psb.notices.dismissed.' + createHash('sha256').update(s.base).digest('hex');

export class NoticeFeed {
    private snapshot?: { scope: string; notices: Notice[] };
    private pending?: { scope: string; promise: Promise<void> };
    private revision = 0;
    constructor(private session: () => Promise<Session>,
        private request: (session: Session, path: string, method?: string) => Promise<any>,
        private storage: Storage, private changed: () => void) {}
    async current(): Promise<Notice[]> {
        const session = await this.session();
        if (this.snapshot?.scope !== identity(session)) return [];
        const closed = session.owner ? [] : this.storage.get<string[]>(storageKey(session), []);
        return this.snapshot.notices.filter(n => (!n.expiresAt || Date.parse(n.expiresAt) > Date.now()) && !closed.includes(n.id));
    }
    async refresh(): Promise<void> {
        const session = await this.session(), scope = identity(session);
        if (this.pending?.scope === scope) return this.pending.promise;
        const revision = this.revision;
        const pending = { scope, promise: Promise.resolve() };
        pending.promise = (async () => {
            try {
                const result = await this.request(session, '/notices');
                if (!Array.isArray(result.notices)) throw new Error('Invalid notices');
                const notices: Notice[] = result.notices.slice(0, 20).filter((n: any) =>
                    n && typeof n.id === 'string' && /^[a-f0-9-]{36}$/i.test(n.id) &&
                    typeof n.title === 'string' && n.title.length <= 120 && typeof n.body === 'string' && n.body.length <= 2000 &&
                    (n.audience === 'all' || session.owner && n.audience === 'user') &&
                    typeof n.createdAt === 'string' && Number.isFinite(Date.parse(n.createdAt)) &&
                    (n.expiresAt === null || typeof n.expiresAt === 'string' && Number.isFinite(Date.parse(n.expiresAt))));
                if (identity(await this.session()) !== scope || this.revision !== revision) return;
                this.snapshot = { scope, notices }; this.changed();
            } catch { /* A notice outage must not interfere with recording or writing. */ }
            finally { if (this.pending === pending) this.pending = undefined; }
        })();
        this.pending = pending;
        return pending.promise;
    }
    async dismiss(id: string) {
        if (!(await this.current()).some(n => n.id === id)) return;
        const session = await this.session(), scope = identity(session);
        // Ignore any read begun before this acknowledgement.
        this.revision++;
        if (session.owner) await this.request(session, '/notices/' + encodeURIComponent(id) + '/dismiss', 'POST');
        else await this.storage.update(storageKey(session), [...new Set([...this.storage.get<string[]>(storageKey(session), []), id])].slice(-200));
        this.revision++;
        if (identity(await this.session()) !== scope || this.snapshot?.scope !== scope) return;
        this.snapshot.notices = this.snapshot.notices.filter(n => n.id !== id); this.changed();
    }
}
