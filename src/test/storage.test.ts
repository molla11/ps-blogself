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
