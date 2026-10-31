import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { accountUsage, AccountUsage, usageView } from '../writing/Usage';

const moduleLoader = require('node:module');
const originalLoad = moduleLoader._load;
moduleLoader._load = function(name: string, ...args: unknown[]) {
    if (name === 'vscode') return { EventEmitter: class { fire() {} }, window: { showInformationMessage() {}, showErrorMessage() {} } };
    return originalLoad.call(this, name, ...args);
};
const { ServiceConnection, ServiceError } = require('../writing/ServiceConnection') as typeof import('../writing/ServiceConnection');
moduleLoader._load = originalLoad;

const sample: AccountUsage = { unit: 'credits', windowSeconds: 3600, hourlyUsedCredits: 6000, freeHourlyUsedCredits: 2469.12, freeHourlyLimitCredits: 5000, freeRemainingCredits: 2530.88, creditBalance: 24000, canStart: true, nextFunding: 'free', totalUsedCredits: 25000, todayRequests: 7, retryAt: null };
function harness() {
    const secrets = new Map<string, string>();
    const settings = { apiUrl: 'http://127.0.0.1:4000/api' };
    const key = (base: string) => 'psb.account.' + createHash('sha256').update(base).digest('hex');
    const seed = (base = settings.apiUrl, token = 'test-token', owner = 'test-user') => secrets.set(key(base), JSON.stringify({token, user: {id: owner, email: owner + '@example.test'}}));
    const connection = new class extends ServiceConnection { get settings() { return settings; } }({ secrets: {
        get: async (name: string) => secrets.get(name), store: async (name: string, value: string) => { secrets.set(name, value); }, delete: async (name: string) => { secrets.delete(name); },
    } } as any);
    seed();
    return { connection, settings, secrets, seed };
}
const response = (usage = sample, id = 'test-user') => Response.json({id, email: id + '@example.test', usage});

async function withFetch(action: () => Promise<void>) {
    const previous = globalThis.fetch;
    try { await action(); } finally { globalThis.fetch = previous; }
}

test('usage uses backend amounts, limits and window without deriving a remaining balance or daily quota', () => {
    const view = usageView(accountUsage({...sample, windowSeconds: 1800, freeRemainingCredits: 1700}));
    assert.equal(view.label, '최근 30분 무료 2,469 / 5,000 · 유료 24,000크레딧');
    assert.match(view.detail, /남은 무료 1,700크레딧/); assert.match(view.detail, /누적 사용 25,000크레딧/); assert.match(view.detail, /오늘 요청 7회/);
    assert.match(view.detail, /전체 사용 6,000크레딧/); assert.match(view.detail, /다음 요청: 무료 크레딧/);
    const credit = usageView(accountUsage({...sample, creditBalance: -500, canStart: false, nextFunding: null}));
    assert.match(credit.label, /유료 -500크레딧/); assert.match(credit.detail, /새 요청을 시작할 수 없습니다/);
    const limited = usageView({...sample, freeHourlyUsedCredits: 12400, freeRemainingCredits: 0, retryAt: '2026-10-31T12:34:56Z'});
    assert.match(limited.label, /12,400 \/ 5,000/); assert.match(limited.detail, /다시 요청 가능:/);
    assert.doesNotMatch(view.label + view.detail, /USD|\$|달러|비용|환산/);
    assert.match(usageView({...sample, creditBalance: 0.025}).label, /유료 0크레딧/);
    assert.match(usageView({...sample, creditBalance: 1.2}).label, /유료 1크레딧/);
    assert.match(usageView({...sample, creditBalance: 1.99}).label, /유료 1크레딧/);
    assert.match(usageView({...sample, creditBalance: -1.2}).label, /유료 -2크레딧/);
    assert.throws(() => accountUsage({...sample, unit: 'USD'}));
    assert.throws(() => accountUsage({requests: 0, dailyLimit: 30}));
    assert.throws(() => accountUsage({...sample, hourlyUsedCredits: NaN}));
    assert.throws(() => accountUsage({...sample, freeRemainingCredits: undefined}));
    assert.equal(accountUsage({...sample, hourlyUsedCredits: 0}).hourlyUsedCredits, 0);
});

test('simultaneous usage refreshes share one authenticated request and round displayed amounts', () => withFetch(async () => {
    const {connection} = harness(); let calls = 0;
    globalThis.fetch = async (url, init) => {
        calls++; assert.equal(String(url), 'http://127.0.0.1:4000/api/me');
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-token');
        return response();
    };
    await Promise.all([connection.refreshUsage(), connection.refreshUsage(), connection.refreshUsage()]);
    assert.equal(calls, 1); assert.equal((await connection.usage())?.label, '최근 1시간 무료 2,469 / 5,000 · 유료 24,000크레딧');
}));

test('a usage failure is unavailable, never a fabricated zero balance; retry recovers', () => withFetch(async () => {
    const {connection} = harness();
    globalThis.fetch = async () => { throw new Error('offline'); };
    await connection.refreshUsage(); assert.equal((await connection.usage())?.status, 'error');
    assert.doesNotMatch((await connection.usage())!.label, /\$0/);
    globalThis.fetch = async () => Response.json({id: 'test-user', usage: {requests: 0}});
    await connection.refreshUsage(); assert.equal((await connection.usage())?.status, 'error');
    globalThis.fetch = async () => response();
    await connection.refreshUsage(); assert.equal((await connection.usage())?.status, 'ready');
}));

test('usage responses from an old server, account or signed-out session cannot restore stale values', () => withFetch(async () => {
    const {connection, settings, seed, secrets} = harness();
    let finish!: (response: Response) => void;
    globalThis.fetch = async () => new Promise(resolve => { finish = resolve; });
    const refresh = connection.refreshUsage();
    await new Promise(resolve => setImmediate(resolve));
    settings.apiUrl = 'http://127.0.0.1:4001/api'; seed();
    finish(response()); await refresh;
    assert.equal((await connection.usage())?.status, 'loading');
    globalThis.fetch = async () => response(); await connection.refreshUsage();
    const changing = connection.refreshUsage(); seed(settings.apiUrl, 'new-token', 'new-user');
    await changing; assert.equal((await connection.usage())?.status, 'loading');
    secrets.clear(); await connection.refreshUsage(); assert.equal(await connection.usage(), undefined);

}));

test('a backend 429 usage snapshot takes priority over an older in-flight balance response', () => withFetch(async () => {
    const {connection} = harness(); let finish!: (response: Response) => void;
    globalThis.fetch = async url => String(url).endsWith('/me') ? new Promise(resolve => { finish = resolve; })
        : Response.json({ message: '서버 한도 도달', code: 'USAGE_LIMIT', usage: {...sample, freeHourlyUsedCredits: 13000, freeRemainingCredits: 0, retryAt: '2026-10-31T12:34:56Z'} }, {status: 429});
    const refresh = connection.refreshUsage(); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(connection.request('/jobs', 'POST', {}), ServiceError);
    finish(response()); await refresh;
    assert.match((await connection.usage())!.label, /13,000/);
    assert.match((await connection.usage())!.detail, /다시 요청 가능:/);
}));

test('job completion requests a fresh server snapshot after any earlier balance query finishes', () => withFetch(async () => {
    const {connection} = harness(); let finish!: (response: Response) => void, calls = 0;
    globalThis.fetch = async () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : response({...sample, freeHourlyUsedCredits: 5000});
    const earlier = connection.refreshUsage(); await new Promise(resolve => setImmediate(resolve));
    const completed = connection.refreshUsage(true);
    finish(response()); await Promise.all([earlier, completed]);
    assert.equal(calls, 2); assert.match((await connection.usage())!.label, /5,000/);
}));

test('a backend 402 displays the actual negative credit balance without calculating a replacement allowance', () => withFetch(async () => {
    const {connection} = harness();
    globalThis.fetch = async () => Response.json({message: 'Credit 충전 필요', usage: {...sample, creditBalance: -400, canStart: false, nextFunding: null}}, {status: 402});
    await assert.rejects(connection.request('/jobs', 'POST', {}), ServiceError);
    assert.match((await connection.usage())!.label, /유료 -400크레딧/);
    assert.match((await connection.usage())!.detail, /새 요청을 시작할 수 없습니다/);
}));

test('an old unauthorized response cannot sign out a newly connected account', () => withFetch(async () => {
    const {connection, seed, settings} = harness(); let finish!: (response: Response) => void;
    globalThis.fetch = async () => new Promise(resolve => { finish = resolve; });
    const refresh = connection.refreshUsage(); await new Promise(resolve => setImmediate(resolve));
    seed(settings.apiUrl, 'new-token', 'new-user');
    finish(Response.json({message: 'old token expired'}, {status: 401})); await refresh;
    assert.equal((await connection.account())?.id, 'new-user');
    assert.equal((await connection.usage())?.status, 'loading');
}));
