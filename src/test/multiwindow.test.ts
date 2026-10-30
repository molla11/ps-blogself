import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FileHistory } from '../types';
import { historyFingerprint, reconstructContents, WritingRequest } from '../writing/model';

const history: FileHistory = { id: 'test', filePath: '/work/solve.py', language: 'python', startedAt: 1, lastModified: 1, requestLogs: [], snapshots: [{ timestamp: 1, hash: 'a', content: 'print(1)' }] };
const request = (id: string): WritingRequest => ({ kind: 'write_blog', requestId: id, instructions: id, source: {fileName: 'solve.py', language: 'python', initialCode: '', finalCode: 'print(1)', changes: [{index: 0, at: new Date(1).toISOString(), diff: '+print(1)'}]}, plan: {title: 'test', summary: '', start: 0, end: 0, steps: []} });
function worker() {
    const child = fork(path.resolve('tests/multiwindow/worker.cjs'), [], { execArgv: ['--require', path.resolve('scripts/register-typescript.cjs')], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let id = 0;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    child.on('message', (message: any) => {
        const call = pending.get(message.id); pending.delete(message.id);
        if (message.error) call?.reject(new Error(message.error)); else call?.resolve(message.value);
    });
    child.on('exit', () => { for (const call of pending.values()) call.reject(new Error('worker exited')); pending.clear(); });
    return {
        async call(action: string, data?: unknown): Promise<any> {
            return new Promise((resolve, reject) => { const key = ++id; pending.set(key, {resolve, reject}); child.send({id: key, action, data}); });
        },
        async kill() { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; } },
    };
}
async function until(check: () => Promise<boolean>) {
    for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error('condition did not become true');
}
async function windows(run: (a: ReturnType<typeof worker>, b: ReturnType<typeof worker>, dir: string) => Promise<void>) {
    const dir = await mkdtemp(path.join(tmpdir(), 'psb-multiwindow-')), a = worker(), b = worker();
    try {
        await Promise.all([a.call('init', {directory: dir, workspace: path.join(dir, 'workspace-a')}), b.call('init', {directory: dir, workspace: path.join(dir, 'workspace-b')})]);
        await run(a, b, dir);
    } finally {
        await Promise.all([a.kill(), b.kill()]);
        await rm(dir, {recursive: true, force: true});
    }
}

test('two hosts share the latest draft; takeover fences stale saves and owner death releases editing', {timeout: 20000}, () => windows(async (a, b) => {
    assert.equal((await a.call('claim', {history})).editable, true);
    await a.call('edit', {title: 'A title', revision: 1});
    const reading = await b.call('claim', {history});
    assert.equal(reading.editable, false); assert.equal(reading.draft.title, 'A title');
    await assert.rejects(b.call('edit', {markdown: 'stale overwrite'}), /다른 창/);
    assert.equal((await a.call('read', history.filePath)).markdown, '');
    assert.equal((await b.call('claim', {history, takeover: true})).editable, true);
    await b.call('edit', {markdown: 'B article', revision: 2});
    await assert.rejects(a.call('edit', {title: 'late A title'}), /다른 창/);
    const latest = await a.call('read', history.filePath);
    assert.equal(latest.title, 'A title'); assert.equal(latest.markdown, 'B article');
    await b.kill();
    const recovered = await a.call('claim', {history});
    assert.equal(recovered.editable, true); assert.equal(recovered.draft.markdown, 'B article');
    await a.call('edit', {title: 'recovered'});
}));

test('shared jobs execute once, stay running in another host, and unrelated jobs run concurrently', {timeout: 20000}, () => windows(async (a, b) => {
    await Promise.all([a.call('create', request('shared')), b.call('create', request('shared'))]);
    await until(async () => (await a.call('stats')).started + (await b.call('stats')).started === 1);
    assert.equal((await a.call('job', 'shared')).status, 'running');
    assert.equal((await b.call('retry', 'shared')).status, 'running');
    await a.call('create', request('another'));
    await until(async () => (await a.call('stats')).running + (await b.call('stats')).running === 2);
    await Promise.all([a.call('finish', 'shared'), b.call('finish', 'shared'), a.call('finish', 'another')]);
    await until(async () => (await b.call('job', 'shared')).status === 'completed' && (await b.call('job', 'another')).status === 'completed');
    assert.equal((await a.call('stats')).started + (await b.call('stats')).started, 2);
}));

test('a dead execution owner requires explicit retry in the remaining window', {timeout: 20000}, () => windows(async (a, b) => {
    await a.call('create', request('survives'));
    await until(async () => (await a.call('stats')).started === 1);
    assert.equal((await b.call('job', 'survives')).status, 'running');
    await a.kill();
    assert.equal((await b.call('job', 'survives')).status, 'failed');
    assert.equal((await b.call('stats')).started, 0);
    await b.call('retry', 'survives');
    await until(async () => (await b.call('stats')).started === 1);
    await b.call('finish', 'survives');
    await until(async () => (await b.call('job', 'survives')).status === 'completed');
}));

test('closing an observing host leaves another host’s live job running', {timeout: 20000}, () => windows(async (a, b) => {
    await a.call('create', request('keep-running'));
    await until(async () => (await a.call('stats')).running === 1);
    assert.equal((await b.call('job', 'keep-running')).status, 'running');
    await b.call('close');
    assert.equal((await a.call('job', 'keep-running')).status, 'running');
    await a.call('finish', 'keep-running');
    await until(async () => (await a.call('job', 'keep-running')).status === 'completed');
}));

test('settings in the same workspace merge simultaneous changes and notify the other host', {timeout: 20000}, () => windows(async (a, b, dir) => {
    await b.call('workspace', path.join(dir, 'workspace-a'));
    await Promise.all([a.call('settings', {root: '/both'}), b.call('settings', {recording: false})]);
    await until(async () => {
        const left = await a.call('settingsValue'), right = await b.call('settingsValue');
        return left.root === '/both' && right.root === '/both' && !left.recording && !right.recording;
    });
    assert.ok((await a.call('settingsValue')).updates > 0 || (await b.call('settingsValue')).updates > 0);
}));

test('cancellation in the observing window aborts the worker and keeps cancellation durable', {timeout: 20000}, () => windows(async (a, b) => {
    await a.call('create', request('cancel'));
    await until(async () => (await a.call('stats')).running === 1);
    await b.call('cancel', 'cancel');
    await until(async () => (await a.call('stats')).running === 0);
    assert.equal((await a.call('job', 'cancel')).status, 'cancelled');
}));

test('workspace settings stay separate and concurrent history writes retain both files and all versions', {timeout: 20000}, () => windows(async (a, b, dir) => {
    await a.call('settings', {root: '/only-a', recording: false});
    assert.equal((await b.call('settings')).root, ''); assert.equal((await b.call('settings')).recording, true);
    const file = path.join(dir, 'shared.py');
    const left = Array.from({length: 12}, (_, i) => 'print("a' + i + '")');
    const right = Array.from({length: 12}, (_, i) => 'print("b' + i + '")');
    await Promise.all([a.call('snapshots', {file, contents: left}), b.call('snapshots', {file, contents: right}), b.call('snapshots', {file: path.join(dir, 'other.py'), contents: ['print(2)']})]);
    const contents = reconstructContents(await a.call('history', file));
    assert.equal(contents.length, 24); assert.deepEqual(new Set(contents), new Set([...left, ...right]));
    assert.equal((await a.call('index')).length, 2);
}));

test('a stale history view cannot delete a different record after another window changes the sequence', {timeout: 20000}, () => windows(async (a, b, dir) => {
    const file = path.join(dir, 'delete.py');
    await a.call('snapshots', {file, contents: ['print(1)', 'print(2)', 'print(3)', 'print(4)']});
    const version = historyFingerprint(await b.call('history', file));
    await a.call('deleteSnapshot', {file, index: 0, version});
    await assert.rejects(b.call('deleteSnapshot', {file, index: 1, version}), /다른 창/);
    assert.deepEqual(reconstructContents(await a.call('history', file)), ['print(2)', 'print(3)', 'print(4)']);
}));

test('oversized snapshots leave existing history intact and recording resumes after shrinking', {timeout: 20000}, () => windows(async (a, _b, dir) => {
    const file = path.join(dir, 'large.c');
    await a.call('snapshots', {file, contents: ['int a;', 'x'.repeat(512 * 1024 + 1), '가'.repeat(200000), 'int b;']});
    assert.deepEqual(reconstructContents(await a.call('history', file)), ['int a;', 'int b;']);
}));
