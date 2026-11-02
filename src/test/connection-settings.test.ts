import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadConnectionEnvironment, PUBLIC_API, PUBLIC_LOGIN, loginUrl, resolveConnectionSettings, requireBackend } from '../writing/ConnectionSettings';

test('connection settings select only a backend URL and cannot enable legacy execution modes', () => {
    const development = { PSB_API_URL: 'http://127.0.0.1:4000/api/' };
    assert.deepEqual(resolveConnectionSettings({}, development), { apiUrl: 'http://127.0.0.1:4000/api' });
    assert.deepEqual(resolveConnectionSettings({}, {}), { apiUrl: PUBLIC_API });
    assert.deepEqual(resolveConnectionSettings({ PSB_AI_MODE: 'direct' }, {}), { apiUrl: PUBLIC_API });
    assert.deepEqual(resolveConnectionSettings({ PSB_API_URL: 'http://[::1]:4011/api' }, development), { apiUrl: 'http://[::1]:4011/api' });
});

test('the production backend can open the branded login page without trusting other origins', () => {
    const id = '1a778f6d-1874-41e2-9206-3d5102a204c8';
    assert.equal(loginUrl(PUBLIC_LOGIN + '/login#' + id, PUBLIC_API), PUBLIC_LOGIN + '/login#' + id);
    assert.equal(loginUrl('https://psb-backend.shinem.dev/auth/login/' + id, PUBLIC_API), 'https://psb-backend.shinem.dev/auth/login/' + id);
    assert.equal(loginUrl('http://127.0.0.1:4000/login#' + id, 'http://127.0.0.1:4000/api'), 'http://127.0.0.1:4000/login#' + id);
    for (const url of ['https://evil.test/login', 'https://auth.shinem.dev.evil.test/login', 'http://auth.shinem.dev/login', 'https://auth.shinem.dev/other', 'https://user:pass@auth.shinem.dev/login', 'javascript:alert(1)']) {
        assert.throws(() => loginUrl(url, PUBLIC_API));
    }
    assert.throws(() => loginUrl(PUBLIC_LOGIN + '/login', 'https://another-backend.test/api'));
});

test('only development reads the extension checkout and accepts only the API URL', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psb-connection-'));
    try {
        assert.deepEqual(await loadConnectionEnvironment(root, true), {});
        await mkdir(path.join(root, 'workspace'));
        await writeFile(path.join(root, 'workspace', '.env'), 'PSB_API_URL=https://unrelated.example/api');
        assert.deepEqual(await loadConnectionEnvironment(root, true), {});
        await writeFile(path.join(root, '.env'), '# local dev\r\nPSB_AI_MODE=direct\r\nPSB_API_URL=http://127.0.0.1:4000/api # URL\r\nUNRELATED_SECRET=not-a-client-setting\r\n');
        assert.deepEqual(await loadConnectionEnvironment(root, true), { PSB_API_URL: 'http://127.0.0.1:4000/api' });
        assert.deepEqual(await loadConnectionEnvironment(root, false), {});
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('blank overrides fall through and nonlocal HTTP or credential-bearing URLs are rejected', () => {
    assert.deepEqual(resolveConnectionSettings({ PSB_API_URL: '' }), { apiUrl: PUBLIC_API });
    for (const apiUrl of ['http://example.com/api', 'http://user:password@localhost:4000/api', 'https://example.com/api?token=secret']) {
        assert.throws(() => resolveConnectionSettings({ PSB_API_URL: apiUrl }), /HTTPS/);
    }
});

test('development requires an available compatible backend instead of an offline fallback', async () => {
    const url = 'http://127.0.0.1:4000/api';
    await requireBackend(url, async (address, options) => {
        assert.equal(address, url + '/config'); assert.equal(options?.redirect, 'error');
        return Response.json({ protocol: 'file-writing-v2' });
    });
    await assert.rejects(requireBackend(url, async () => { throw new TypeError('offline'); }), /백엔드에 연결할 수 없습니다/);
    for (const response of [Response.json({ protocol: 'old' }), Response.json({ protocol: 'file-writing-v2' }, { status: 503 }), new Response('not JSON')]) {
        await assert.rejects(requireBackend(url, async () => response), /호환되는/);
    }
});
