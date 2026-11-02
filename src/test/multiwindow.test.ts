import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FileHistory } from '../types';
import { historyFingerprint, reconstructContents } from '../writing/model';

const history: FileHistory = { id: 'test', filePath: '/work/solve.py', language: 'python', startedAt: 1, lastModified: 1, requestLogs: [], snapshots: [{ timestamp: 1, hash: 'a', content: 'print(1)' }] };
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




test('settings in the same workspace merge simultaneous changes and notify the other host', {timeout: 20000}, () => windows(async (a, b, dir) => {
    await b.call('workspace', path.join(dir, 'workspace-a'));
    await Promise.all([a.call('settings', {root: '/both'}), b.call('settings', {recording: false})]);
    await until(async () => {
        const left = await a.call('settingsValue'), right = await b.call('settingsValue');
        return left.root === '/both' && right.root === '/both' && !left.recording && !right.recording;
    });
    assert.ok((await a.call('settingsValue')).updates > 0 || (await b.call('settingsValue')).updates > 0);
}));

test('current-directory roots stay local to each host, including recording and later resets', {timeout: 20000}, () => windows(async (a, b, dir) => {
    const left = path.join(dir, 'project-a'), right = path.join(dir, 'project-b');
    await Promise.all([mkdir(left), mkdir(right)]);
    const shared = { directory: dir, workspace: path.join(dir, 'config-workspace'), folders: [left, right] };
    await Promise.all([
        a.call('configInit', { ...shared, activeFile: path.join(left, 'solve.py') }),
        b.call('configInit', { ...shared, activeFile: path.join(right, 'solve.py') }),
    ]);
    await a.call('configRoot', { path: dir });
    await until(async () => (await b.call('configValue')).root === dir);
    await a.call('configRoot', { windowOnly: true });
    assert.equal((await a.call('configValue')).root, left);
    assert.equal((await b.call('configValue')).root, dir);
    await b.call('configRoot', { windowOnly: true });
    assert.equal((await b.call('configValue')).root, right);
    await Promise.all([
        a.call('recordDocument', { file: path.join(left, 'solve.py'), content: 'print("left")' }),
        b.call('recordDocument', { file: path.join(right, 'solve.py'), content: 'print("right")' }),
        a.call('recordDocument', { file: path.join(right, 'excluded-a.py'), content: 'print("excluded")' }),
        b.call('recordDocument', { file: path.join(left, 'excluded-b.py'), content: 'print("excluded")' }),
    ]);
    assert.deepEqual(new Set((await a.call('index')).map((item: any) => item.filePath)), new Set([path.join(left, 'solve.py'), path.join(right, 'solve.py')]));
    // Changing editor focus updates the next folder choice, not the selected root.
    const switched = await a.call('configActiveFile', path.join(right, 'other.py'));
    assert.equal(switched.currentDirectory, right); assert.equal(switched.root, left);
    await Promise.all([a.call('configLanguages', ['py', 'rs']), b.call('configRecording', false)]);
    await until(async () => {
        const av = await a.call('configValue'), bv = await b.call('configValue');
        return !av.recording && bv.languages.includes('rs');
    });
    assert.equal((await a.call('configValue')).root, left);
    assert.equal((await b.call('configValue')).root, right);
    await a.call('configRoot', { path: '' });
    assert.equal((await a.call('configValue')).root, '');
    assert.equal((await a.call('configValue')).windowRoot, true);
    assert.equal((await b.call('configValue')).root, right);
    await a.call('configRoot', { path: left });
    await assert.rejects(a.call('configRoot', { path: path.join(dir, 'missing') }), /존재하는 폴더/);
    assert.equal((await a.call('configValue')).root, left);
    assert.equal((await b.call('configValue')).root, right);
    const reloaded = await a.call('configReload');
    assert.equal(reloaded.root, dir); assert.equal(reloaded.windowRoot, false);
    await a.call('configRoot', { path: left });
    await b.call('configReload');
    assert.equal((await b.call('configValue')).root, left);
}));

test('a window without a workspace can independently use the open file directory', {timeout: 20000}, () => windows(async (a, b, dir) => {
    const left = path.join(dir, 'loose-a'), right = path.join(dir, 'loose-b');
    await Promise.all([mkdir(left), mkdir(right)]);
    await Promise.all([
        a.call('configInit', { directory: dir, folders: [], activeFile: path.join(left, 'solve.py') }),
        b.call('configInit', { directory: dir, folders: [], activeFile: path.join(right, 'solve.py') }),
    ]);
    await Promise.all([a.call('configRoot', { windowOnly: true }), b.call('configRoot', { windowOnly: true })]);
    assert.equal((await a.call('configValue')).root, left);
    assert.equal((await b.call('configValue')).root, right);
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
