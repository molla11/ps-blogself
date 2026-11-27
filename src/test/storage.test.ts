import { describe as suite, test, type TestContext } from 'node:test';
import type { FileHistory, SnapshotTrigger } from '../types';
import * as assert from 'assert';
import { nextEditBatch } from '../storage/EditBatch';
import { changedSpan, computeDiff, getHash } from '../storage/utils';

suite('Storage Logic Suite', () => {
    test('computeDiff - small change in middle (long file)', () => {
        // Create text > 200 chars
        const padding = 'X'.repeat(200);
        const oldText = padding + 'Hello World! This is a test.';
        const newText = padding + 'Hello Universe! This is a test.';

        const diff = computeDiff(oldText, newText);

        assert.ok(diff, 'Diff should be generated for small change in long file');
        assert.strictEqual(diff!.newText, 'Universe');

        // Validation
        const reconstructed =
            oldText.substring(0, diff!.start) + diff!.newText + oldText.substring(diff!.end);
        assert.strictEqual(reconstructed, newText);
    });

    test('computeDiff - small file retains a compact patch', () => {
        const oldText = 'Hello World! This is a test.';
        const newText = 'Hello Universe! This is a test.';

        const diff = computeDiff(oldText, newText);
        assert.ok(diff, 'Small edits use a patch');
        assert.strictEqual(
            oldText.slice(0, diff.start) + diff.newText + oldText.slice(diff.end),
            newText,
        );
    });

    test('computeDiff - one-character edit in a short file', () => {
        const oldText = 'A'.repeat(50);
        const newText = 'A'.repeat(49) + 'B'; // Length 50

        const diff = computeDiff(oldText, newText);
        assert.ok(diff, 'Small edits use a patch');
        assert.strictEqual(
            oldText.slice(0, diff.start) + diff.newText + oldText.slice(diff.end),
            newText,
        );
    });

    test('computeDiff - changes above the byte limit use full snapshots', () => {
        const oldText = 'A'.repeat(300);
        const newText = 'A'.repeat(300) + 'B'.repeat(501); // Change > 500 bytes

        const diff = computeDiff(oldText, newText);
        assert.strictEqual(diff, null, 'Should return null for large changes');
    });

    test('computeDiff - large file with small change', () => {
        const prefix = 'A'.repeat(150);
        const suffix = 'B'.repeat(150);
        const oldText = prefix + 'OLD' + suffix; // 303 chars
        const newText = prefix + 'NEW' + suffix;

        const diff = computeDiff(oldText, newText);

        assert.ok(diff, 'Diff should be generated');
        assert.strictEqual(diff!.newText, 'NEW');

        const reconstructed =
            oldText.substring(0, diff!.start) + diff!.newText + oldText.substring(diff!.end);
        assert.strictEqual(reconstructed, newText);
    });
});

async function storageFixture(t: TestContext) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'psb-retry-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const uri = (fsPath: string) => ({ fsPath, toString: () => fsPath });
    const Module = require('node:module'), original = Module._load;
    Module._load = function(name: string, ...args: unknown[]) {
        if (name === 'vscode') {return {
            Uri: { joinPath: (base: { fsPath: string }, file: string) => uri(path.join(base.fsPath, file)) },
            EventEmitter: class { event = () => {}; fire() {} },
        };}
        return original.call(this, name, ...args);
    };
    let manager;
    try { manager = require('../storage/StorageManager').StorageManager.getInstance(); }
    finally { Module._load = original; }
    manager.init({ globalStorageUri: uri(dir) });
    const raw = async (file: string) => JSON.parse(await fs.readFile(path.join(dir, 'history', getHash(file) + '.json'), 'utf8')) as FileHistory;
    return { manager, dir, fs, path, uri, raw };
}

test('an index write failure retains immutable snapshots in order and repairs a partial commit', async t => {
    const { manager, dir, fs, path, uri } = await storageFixture(t);
    const index = path.join(dir, 'session-index.json');
    await fs.mkdir(index);
    let content = 'first';
    const document = { uri: uri('/project/solve.py'), languageId: 'python', getText: () => content };
    await assert.rejects(manager.saveSnapshot(document, '', 'save'));
    content = 'second';
    await assert.rejects(manager.saveSnapshot(document, '', 'save'));
    assert.equal(manager.unsavedSnapshots, 2);
    await assert.rejects(manager.flush());
    content = 'unsaved';
    await fs.rmdir(index);
    await manager.flush();
    assert.equal(manager.unsavedSnapshots, 0);
    const history = await manager.getFileHistory(document.uri.fsPath);
    assert.equal(history.snapshots.length, 2);
    assert.deepEqual([0, 1].map(i => manager.reconstructFileContent(history, i)), ['first', 'second']);
    const rows = await manager.getAllLogs();
    assert.equal(rows[0].filePath, document.uri.fsPath);
    const stat = await fs.stat(index, { bigint: true });
    await manager.getAllLogs();
    assert.equal((await fs.stat(index, { bigint: true })).ino, stat.ino);
    await fs.writeFile(index, '[]');
    assert.deepEqual(await manager.getAllLogs(), rows);
});

test('bursts replace the durable tail, preserve deletion boundaries, and respect stable references', async t => {
    const { manager, uri, raw } = await storageFixture(t);
    const doc = { uri: uri('/work/code.cpp'), languageId: 'cpp', getText: () => '' };
    const save = (value: string, trigger: SnapshotTrigger = 'save', session = 'editor-one', undo = false) =>
        manager.saveSnapshot({ ...doc, getText: () => value }, '', trigger, session, undo);
    const read = () => raw(doc.uri.fsPath);
    const versions = (h: FileHistory) => h.snapshots.map((_, i) => manager.reconstructFileContent(h, i));
    await save('');
    await save('result');
    await save('resultValue');
    assert.deepEqual(versions(await read()), ['', 'resultValue']);
    await save('result'); // correcting a recently typed name stays in the same stage
    await save('resultCode');
    await save('resultCodeHere');
    assert.deepEqual(versions(await read()), ['', 'resultCodeHere']);
    const sealed: FileHistory = await manager.getFileHistory(doc.uri.fsPath);
    assert.equal(sealed.openEdit, undefined);
    await save('resultCodeHereNext');
    await save('resultCodeHereNext', 'run');
    await save('resultCodeHereNextPart');
    await save('resultCodeHereNextPartExtra', 'save', 'second-host');
    const after = await read();
    assert.deepEqual(versions(after).slice(0, sealed.snapshots.length), versions(sealed));
    assert.deepEqual(after.snapshots[sealed.snapshots.length].checkpoints, ['save', 'run']);
    assert.deepEqual(versions(after).slice(sealed.snapshots.length), ['resultCodeHereNext', 'resultCodeHereNextPart', 'resultCodeHereNextPartExtra']);
});

test('only a verified undo of a recent unsealed insertion cancels an intermediate version', async t => {
    const { manager, uri, raw } = await storageFixture(t);
    const doc = { uri: uri('/work/undo.cpp'), languageId: 'cpp' };
    const save = (value: string, undo = false) => manager.saveSnapshot({ ...doc, getText: () => value }, '', 'save', 'same', undo);
    const versions = async () => {
        const h = await raw(doc.uri.fsPath);
        return h.snapshots.map((_, index) => manager.reconstructFileContent(h, index));
    };
    await save(''); await save('word'); await save('wordSuffix');
    await save('word', true);
    assert.deepEqual(await versions(), ['', 'word']);
    await save('wordTypo'); await save('word', true);
    assert.deepEqual(await versions(), ['', 'word']);
    await save('wordWrong'); await save('wor', true);
    assert.deepEqual(await versions(), ['', 'word', 'wordWrong', 'wor']);
});

test('continuous editing groups small corrections by time, with boundaries for pauses, sections and destructive edits', () => {
    const h: FileHistory = { id: 'x', filePath: '/work/example', language: 'cpp', startedAt: 0, lastModified: 0, snapshots: [], requestLogs: [] };
    const last = { hash: 'prior', timestamp: 235_000 };
    h.snapshots.push(last);
    const prior = h.openEdit = { index: 0, hash: last.hash, session: 'a', since: 0, count: 90, start: 0, end: 10, initialLength: 10 };
    const check = (before: string, after: string, time: number, trigger: SnapshotTrigger = 'save') =>
        nextEditBatch(h, last, before, after, changedSpan(before, after), 'a', trigger, time);
    for (const trigger of ['idle', 'deadline', 'switch', 'blur', 'autosave'] as const) {
        assert.equal(check('answer++', 'answer+', 299_999, trigger)?.count, 91);
    }
    assert.equal(check('answer++', 'answer+', 300_000)?.count, 1);
    assert.equal(check('answer', 'answer;', 240_000)?.count, 1);
    assert.equal(check('answer', 'answer;', 234_999)?.count, 1); // clock moved back
    assert.equal(check('answer', 'answer;', 240_000, 'run'), undefined);
    last.timestamp = 0;
    for (const gap of [119_999, 120_000, 120_001]) {
        assert.equal(check('answer++', 'answer+', gap)?.count, gap < 120_000 ? 91 : 1);
    }
    const distant = 'first\n' + 'another line\n'.repeat(10);
    assert.equal(check(distant, distant + 'end', 59_999)?.count, 91);
    assert.equal(check(distant, distant + 'end', 60_000)?.count, 1);
    // Edits at opposite ends of the same code span do not count as replacing its entire body.
    assert.equal(check(distant, 'X' + distant.slice(1, -1) + 'Y', 5_000)?.count, 91);
    assert.equal(check(distant, 'first\n', 5_000), undefined);
    assert.equal(check('ready();\nreturn result;\n', 'ready();\n', 5_000), undefined);
    assert.equal(check('ready();\nreturn result;', 'ready();\n', 5_000), undefined);
    prior.initialLength = 250;
    assert.equal(check('a'.repeat(91), 'a'.repeat(90), 5_000), undefined);
    prior.hash = 'different writer';
    assert.equal(check('result', 'resultValue', 5_000)?.count, 1);
});

test('repeated saves for twelve minutes produce four durable stages with reconstructable contents', async t => {
    const { manager, uri, raw } = await storageFixture(t);
    const file = '/work/cadence.cpp', document = { uri: uri(file), languageId: 'cpp' };
    let text = '';
    const captures = [];
    for (let seconds = 0; seconds < 720; seconds += 5) {
        text += seconds % 10 === 0 ? 'name' : '();\n';
        captures.push(text);
        await manager._saveSnapshot({ document, content: text, baseline: '', editSession: 'one', trigger: 'save', timestamp: seconds * 1000 });
    }
    const history = await raw(file);
    assert.equal(history.snapshots.length, 4);
    for (const [i, s] of history.snapshots.entries()) {
        assert.equal(manager.reconstructFileContent(history, i), captures[s.timestamp / 5000]);
    }
    assert.equal(manager.reconstructFileContent(history, 3), text);
});

test('a second window reviewing the tail fences both saves and Undo, even when they race', async t => {
    const { manager, dir, uri, raw } = await storageFixture(t);
    const reader = new manager.constructor();
    reader.init({ globalStorageUri: uri(dir) });
    const file = '/work/review.cpp';
    const save = (text: string, undo = false) => manager.saveSnapshot(
        { uri: uri(file), languageId: 'cpp', getText: () => text }, '', 'save', 'writer', undo);
    await save(''); await save('value');
    const [reviewed] = await Promise.all([reader.getFileHistory(file), save('valueSuffix')]);
    await save('valueSuffixMore');
    const current = await raw(file);
    const hashes = (h: FileHistory) => h.snapshots.map(s => s.hash);
    assert.deepEqual(hashes(current).slice(0, reviewed.snapshots.length), hashes(reviewed));
    await reader.getFileHistory(file);
    await save('valueSuffix', true);
    assert.deepEqual(hashes(await raw(file)).slice(0, current.snapshots.length), hashes(current));

    // An Undo to an older state cannot cancel a different intervening insertion.
    await save('valueSuffixA'); await save('valueSuffixAB'); await save('valueSuffix', true);
    const after = await raw(file);
    assert.deepEqual(after.snapshots.slice(-2).map(s => s.hash), [getHash('valueSuffixAB'), getHash('valueSuffix')]);
});
