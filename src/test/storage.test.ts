import { describe as suite, test } from 'node:test';
import * as assert from 'assert';
import { computeDiff } from '../storage/utils';

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

test('an index write failure retains immutable snapshots in order and repairs a partial commit', async t => {
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
