import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { NoticeFeed } from '../writing/NoticeFeed';

const item = { id: '12345678-1234-4234-8234-123456789012', title: '안내', body: '<b>원문</b>', audience: 'all', createdAt: new Date().toISOString(), expiresAt: null };
function fixture() {
    let session: { base: string; token?: string; owner?: string } = { base: 'https://example.test/api' };
    const values = new Map<string, any>(), requests: string[] = [];
    let fetcher = async (_route: string) => ({ notices: [item] });
    const storage = { get: <T>(key: string, fallback: T): T => values.get(key) ?? fallback, update: async (key: string, value: unknown) => { values.set(key, value); } };
    const feed = new NoticeFeed(async () => session, async (_session, route) => { requests.push(route); return fetcher(route); }, storage, () => {});
    return { feed, requests, values, setSession: (next: typeof session) => { session = next; }, setFetch: (next: typeof fetcher) => { fetcher = next; } };
}
test('public notices dismiss locally, while signed-in dismissals go to the server', async () => {
    const f = fixture(); await f.feed.refresh();
    assert.equal((await f.feed.current())[0].body, item.body);
    await f.feed.dismiss(item.id); await f.feed.refresh(); assert.deepEqual(await f.feed.current(), []);
    assert.ok(f.requests.every(route => route === '/notices'));
    f.setSession({ base: 'https://example.test/api', token: 'token', owner: 'user' });
    assert.deepEqual(await f.feed.current(), []);
    await f.feed.refresh(); await f.feed.dismiss(item.id);
    assert.equal(f.requests.at(-1), '/notices/' + item.id + '/dismiss');
    assert.deepEqual(await f.feed.current(), []);
});
test('old account responses and reads racing dismissal cannot restore private or closed notices', async () => {
    const f = fixture(); f.setSession({ base: 'https://example.test/api', token: 'a', owner: 'a' });
    await f.feed.refresh();
    let finish!: (value: any) => void;
    f.setFetch(route => route.endsWith('/dismiss') ? Promise.resolve({ notices: [] }) : new Promise(resolve => { finish = resolve; }));
    const reading = f.feed.refresh(); await new Promise(resolve => setImmediate(resolve));
    await f.feed.dismiss(item.id); finish({ notices: [item] }); await reading;
    assert.deepEqual(await f.feed.current(), []);
    const switching = f.feed.refresh(); await new Promise(resolve => setImmediate(resolve));
    f.setSession({ base: 'https://example.test/api', token: 'b', owner: 'b' });
    finish({ notices: [{ ...item, audience: 'user' }] }); await switching;
    assert.deepEqual(await f.feed.current(), []);
});
test('malformed, expired and anonymous personal notices are not displayed; failures preserve valid notices', async () => {
    const f = fixture();
    f.setFetch(async () => ({ notices: [item, { ...item, audience: 'user' }, { ...item, expiresAt: new Date(0).toISOString() }, { ...item, title: 42 } as any] }));
    await Promise.all([f.feed.refresh(), f.feed.refresh()]);
    assert.equal(f.requests.length, 1); assert.equal((await f.feed.current()).length, 1);
    f.setFetch(async () => { throw new Error('offline'); }); await f.feed.refresh();
    assert.equal((await f.feed.current()).length, 1);
});
