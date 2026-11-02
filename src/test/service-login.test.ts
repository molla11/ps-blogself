import { test, TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { PUBLIC_API, PUBLIC_LOGIN } from '../writing/ConnectionSettings';
import { LOGIN_BRIDGE_URL, startLoginBridge } from '../writing/LoginBridge';

const actualFetch = globalThis.fetch;
const id = '1a778f6d-1874-41e2-9206-3d5102a204c8';
const nonce = 'a'.repeat(64);
const moduleLoader = require('node:module');
const originalLoad = moduleLoader._load;
const vscodeMock = {
    EventEmitter: class { fire() {} },
    ProgressLocation: { Notification: 15 },
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    window: { async withProgress(_options: unknown, _callback: any): Promise<any> {} },
    env: { async asExternalUri(uri: unknown) { return uri; }, async openExternal(_uri: unknown) { return true; } },
};
moduleLoader._load = function(name: string, ...args: unknown[]) {
    return name === 'vscode' ? vscodeMock : originalLoad.call(this, name, ...args);
};
const { ServiceConnection } = require('../writing/ServiceConnection') as typeof import('../writing/ServiceConnection');
moduleLoader._load = originalLoad;

function connect(options: RequestInit = {}) {
    return actualFetch(LOGIN_BRIDGE_URL, { method: 'POST', headers: { Origin: PUBLIC_LOGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }), ...options });
}
async function closed() { await assert.rejects(connect()); }

function harness(t: TestContext, options: { legacy?: boolean; remote?: boolean; cancelled?: boolean; open?: boolean } = {}) {
    const secrets = new Map<string, string>(), events: string[] = [];
    const context = { subscriptions: [] as any[], secrets: {
        async get(key: string) { return secrets.get(key); }, async store(key: string, value: string) { secrets.set(key, value); },
    } };
    let cancelListener = () => {};
    const cancellation = { isCancellationRequested: false, onCancellationRequested(listener: () => void) { cancelListener = listener; return { dispose() {} }; } };
    let challenge = '';
    const connection = new class extends ServiceConnection { get settings() { return { apiUrl: PUBLIC_API }; } }(context as any);
    t.mock.method(connection, 'refreshUsage', async () => {});
    t.mock.method(connection.notices, 'refresh', async () => {});
    t.mock.method(vscodeMock.window, 'withProgress', async (_options: unknown, callback: any) => callback({}, cancellation));
    t.mock.method(vscodeMock.env, 'asExternalUri', async (uri: unknown) => options.remote ? vscodeMock.Uri.parse('https://remote.test/connect') : uri);
    t.mock.method(vscodeMock.env, 'openExternal', async (uri: unknown) => {
        events.push(String(uri));
        const response = await connect();
        assert.equal(response.status, 200);
        const body = await response.json() as { id: string };
        assert.equal(body.id, id);
        assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'id', 'protocol']);
        if (options.cancelled) { cancellation.isCancellationRequested = true; cancelListener(); }
        return options.open !== false;
    });
    const request = t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const route = String(url).slice(PUBLIC_API.length);
        if (route === '/config') return Response.json({ protocol: 'file-writing-v2', authMode: 'supabase' });
        const body = JSON.parse(String(init?.body));
        if (route === '/auth/start') {
            assert.equal(body.presentation, 'automatic'); challenge = body.challenge;
            return Response.json({ id, loginUrl: PUBLIC_LOGIN + '/login' + (options.legacy ? '#' + id : ''), ...options.legacy ? {} : { bridge: 'loopback-v1' } });
        }
        assert.equal(route, '/auth/exchange');
        assert.equal(body.id, id);
        assert.equal(createHash('sha256').update(body.verifier).digest('base64url'), challenge);
        return Response.json({ token: 'device-token', user: { id: 'user', email: 'user@example.test' } });
    });
    return { connection, context, secrets, events, request };
}

test('automatic login opens exactly the branded URL, shares no verifier, exchanges with PKCE and closes its bridge', async t => {
    const h = harness(t);
    assert.equal((await h.connection.credentials()).token, 'device-token');
    assert.deepEqual(h.events, ['https://auth.shinem.dev/login']);
    assert.equal(h.secrets.size, 1);
    assert.equal(h.context.subscriptions.length, 0);
    await closed();
});

test('cancellation closes the bridge and does not exchange or store credentials', async t => {
    const h = harness(t, { cancelled: true });
    await assert.rejects(h.connection.credentials(), /취소/);
    assert.equal(h.request.mock.callCount(), 2);
    assert.equal(h.secrets.size, 0);
    await closed();
});

test('a failed browser launch closes the bridge', async t => {
    const h = harness(t, { open: false });
    await assert.rejects(h.connection.credentials(), /브라우저/);
    assert.equal(h.secrets.size, 0);
    await closed();
});

test('an older backend cannot silently reopen a URL containing the flow identifier', async t => {
    const h = harness(t, { legacy: true });
    await assert.rejects(h.connection.credentials(), /백엔드로 업데이트/);
    assert.deepEqual(h.events, []);
    await closed();
});

test('an incompatible remote port mapping fails before opening the browser and releases the port', async t => {
    const h = harness(t, { remote: true });
    await assert.rejects(h.connection.credentials(), /원격 창/);
    assert.deepEqual(h.events, []);
    await closed();
});

test('bridge requires exact origin and host, JSON POST, bounded input and binds one browser nonce', async () => {
    const bridge = await startLoginBridge(PUBLIC_LOGIN, id, Date.now() + 60000);
    try {
        for (const origin of [undefined, 'null', 'https://evil.test', PUBLIC_LOGIN + '.evil.test']) {
            assert.equal((await connect({ headers: { ...origin ? { Origin: origin } : {}, 'Content-Type': 'application/json' } })).status, 403);
        }
        const preflight = await connect({ method: 'OPTIONS', body: undefined, headers: { Origin: PUBLIC_LOGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), PUBLIC_LOGIN);
        assert.equal((await connect({ method: 'GET', body: undefined })).status, 405);
        assert.equal((await connect({ headers: { Origin: PUBLIC_LOGIN, 'Content-Type': 'text/plain' } })).status, 415);
        assert.equal((await connect({ body: 'x'.repeat(1025) })).status, 413);
        assert.equal((await connect({ body: '{}' })).status, 400);
        assert.equal((await connect({ body: 'null' })).status, 400);
        const badHost = await new Promise<number | undefined>((resolve, reject) => {
            const req = httpRequest(LOGIN_BRIDGE_URL, { method: 'POST', headers: { Host: 'evil.test:49629', Origin: PUBLIC_LOGIN } }, response => { response.resume(); resolve(response.statusCode); });
            req.on('error', reject); req.end();
        });
        assert.equal(badHost, 403);
        assert.equal((await connect()).status, 200);
        assert.equal((await connect()).status, 200);
        assert.equal((await connect({ body: JSON.stringify({ nonce: 'b'.repeat(64) }) })).status, 409);
        await assert.rejects(startLoginBridge(PUBLIC_LOGIN, 'another-flow', Date.now() + 60000), /사용 중/);
        assert.equal((await connect()).status, 200);
    } finally { bridge.dispose(); }
    await closed();
});

test('a bridge expires even if its caller never disposes it', async () => {
    const bridge = await startLoginBridge(PUBLIC_LOGIN, id, Date.now() + 25);
    try { await new Promise(resolve => setTimeout(resolve, 50)); await closed(); }
    finally { bridge.dispose(); }
});
