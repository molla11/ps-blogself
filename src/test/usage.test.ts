import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { accountUsage, AccountUsage, usageView } from '../writing/Usage';

const moduleLoader = require('node:module');
const originalLoad = moduleLoader._load;
const vscodeMock = {
    EventEmitter: class { fire() {} },
    window: { async showInformationMessage(..._args: unknown[]): Promise<string | undefined> { return undefined; }, showErrorMessage() {} },
    env: { clipboard: { async writeText(_text: string) {} } },
};
moduleLoader._load = function(name: string, ...args: unknown[]) {
    if (name === 'vscode') return vscodeMock;
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
    assert.equal(view.label, '남은 무료 크레딧: 1,700 / 5,000');
    assert.deepEqual(view.detail.split('\n'), [
        '남은 크레딧: 무료 1,700 · 유료 24,000',
        '무료 크레딧은 사용한 만큼이 30분 뒤 채워집니다.',
        '현재 선택된 모델은 다음 요청에 무료 크레딧을 사용합니다.',
        '',
        '최근 30분 사용 6,000크레딧 (무료 2,469 / 5,000)',
        '오늘 요청 7회 · 누적 사용 25,000크레딧',
    ]);
    assert.match(usageView({...sample, nextFunding: 'credit'}).detail, /다음 요청에 유료 크레딧/);
    const credit = usageView(accountUsage({...sample, creditBalance: -500, canStart: false, nextFunding: null}));
    assert.match(credit.paidLabel!, /유료 크레딧: -500$/); assert.match(credit.detail, /새 요청을 시작할 수 없어요/);
    const limited = usageView({...sample, freeHourlyUsedCredits: 12400, freeRemainingCredits: 0, retryAt: '2026-10-31T12:34:56Z'});
    assert.equal(limited.label, '남은 무료 크레딧: 0 / 5,000');
    assert.match(limited.detail, /12,400 \/ 5,000/); assert.match(limited.detail, /다시 요청 가능 ·/);
    assert.doesNotMatch(view.label + view.detail, /USD|\$|달러|비용|환산/);
    assert.match(usageView({...sample, creditBalance: 0.025}).paidLabel!, /유료 크레딧: 0$/);
    assert.match(usageView({...sample, creditBalance: 1.2}).paidLabel!, /유료 크레딧: 1$/);
    assert.match(usageView({...sample, creditBalance: 1.99}).paidLabel!, /유료 크레딧: 1$/);
    assert.match(usageView({...sample, creditBalance: -1.2}).paidLabel!, /유료 크레딧: -2$/);
    const reset = '2026-11-29T12:00:00.000Z';
    const hourly = usageView(accountUsage({...sample, resetsAt: reset}));
    assert.equal(hourly.resetsAt, reset);
    assert.match(hourly.detail, /계정 접속 시각을 기준으로 1시간마다/);
    assert.throws(() => accountUsage({...sample, resetsAt: 'unknown'}));
    assert.throws(() => accountUsage({...sample, unit: 'USD'}));
    assert.throws(() => accountUsage({requests: 0, dailyLimit: 30}));
    assert.throws(() => accountUsage({...sample, hourlyUsedCredits: NaN}));
    assert.throws(() => accountUsage({...sample, freeRemainingCredits: undefined}));
    assert.equal(accountUsage({...sample, hourlyUsedCredits: 0}).hourlyUsedCredits, 0);
});

test('opening usage displays the balances and history in a multiline dialog', async t => {
    const { connection } = harness();
    t.mock.method(globalThis, 'fetch', async () => response());
    const dialog = t.mock.method(vscodeMock.window, 'showInformationMessage');
    await connection.showUsage();
    assert.deepEqual(dialog.mock.calls[0].arguments, [
        '크레딧 사용량', { modal: true, detail: usageView(sample).detail }, { title: '닫기', isCloseAffordance: true },
    ]);
});

test('simultaneous usage refreshes share one authenticated request and round displayed amounts', () => withFetch(async () => {
    const {connection} = harness(); let calls = 0;
    globalThis.fetch = async (url, init) => {
        calls++; assert.equal(String(url), 'http://127.0.0.1:4000/api/me');
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-token');
        return response();
    };
    await Promise.all([connection.refreshUsage(), connection.refreshUsage(), connection.refreshUsage()]);
    assert.equal(calls, 1); assert.equal((await connection.usage())?.label, '남은 무료 크레딧: 2,530 / 5,000');
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
    assert.match((await connection.usage())!.detail, /무료 13,000 \/ 5,000/);
    assert.match((await connection.usage())!.detail, /다시 요청 가능 ·/);
}));

test('job completion requests a fresh server snapshot after any earlier balance query finishes', () => withFetch(async () => {
    const {connection} = harness(); let finish!: (response: Response) => void, calls = 0;
    globalThis.fetch = async () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : response({...sample, freeHourlyUsedCredits: 5000});
    const earlier = connection.refreshUsage(); await new Promise(resolve => setImmediate(resolve));
    const completed = connection.refreshUsage(true);
    finish(response()); await Promise.all([earlier, completed]);
    assert.equal(calls, 2); assert.match((await connection.usage())!.detail, /무료 5,000 \/ 5,000/);
}));

test('a backend 402 displays the actual negative credit balance without calculating a replacement allowance', () => withFetch(async () => {
    const {connection} = harness();
    globalThis.fetch = async () => Response.json({message: 'Credit 충전 필요', usage: {...sample, creditBalance: -400, canStart: false, nextFunding: null}}, {status: 402});
    await assert.rejects(connection.request('/jobs', 'POST', {}), ServiceError);
    assert.match((await connection.usage())!.paidLabel!, /유료 크레딧: -400$/);
    assert.match((await connection.usage())!.detail, /새 요청을 시작할 수 없어요/);
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

test('paid model selection checks current backend availability even when free credits remain', () => withFetch(async () => {
    const { connection } = harness();
    let calls = 0;
    for (const creditBalance of [100, 0, -5, 0.025]) {
        globalThis.fetch = async () => {
            calls++;
            return response({ ...sample, creditBalance, models: [
                { id: 'opus5.5', paidOnly: true, available: creditBalance > 0, nextFunding: creditBalance > 0 ? 'credit' : null },
                { id: 'astra', paidOnly: true, available: creditBalance > 0, nextFunding: creditBalance > 0 ? 'credit' : null },
            ] });
        };
        for (const id of ['opus5.5', 'astra'] as const) {
            const result = await connection.checkWritingModel(id);
            assert.equal(result.allowed, creditBalance > 0);
            if (!result.allowed) assert.equal(result.message, '유료 크레딧이 없어 이전 모델을 유지했습니다.');
        }
    }
    assert.equal(calls, 8);
    // The displayed balance rounds down; availability still comes from the server.
    assert.match((await connection.usage())!.paidLabel!, /유료 크레딧: 0$/);
}));

test('unverified paid model choices retain the previous model without initiating login or AI work', () => withFetch(async () => {
    const { connection, secrets } = harness();
    for (const fetcher of [
        async () => { throw new Error('offline'); },
        async () => response(),
        async () => response({ ...sample, models: [{ id: 'astra', paidOnly: true, available: false, nextFunding: null }] }),
    ]) {
        globalThis.fetch = fetcher;
        assert.equal((await connection.checkWritingModel('opus5.5')).allowed, false);
    }
    secrets.clear();
    globalThis.fetch = async () => { assert.fail('Signed-out selection must not make a request'); };
    assert.deepEqual(await connection.checkWritingModel('astra'), { allowed: false, message: '로그인 후 유료 크레딧을 확인해 주세요.' });
}));

test('a balance check from a previous account cannot approve a paid model', () => withFetch(async () => {
    const { connection, seed, settings } = harness();
    let finish!: (response: Response) => void;
    globalThis.fetch = async () => new Promise(resolve => { finish = resolve; });
    const check = connection.checkWritingModel('astra');
    await new Promise(resolve => setImmediate(resolve));
    seed(settings.apiUrl, 'new-token', 'new-user');
    finish(response({ ...sample, models: [{ id: 'astra', paidOnly: true, available: true, nextFunding: 'credit' }] }));
    assert.equal((await check).allowed, false);
}));
