import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { normalizeExtensions } from '../settings/RecordingInput';

test('recording extensions normalize dot prefixes, casing and duplicates without inventing enabled types', () => {
    assert.deepEqual(normalizeExtensions(['.CPP', ' cpp ', 'py', '.JS', 'rs']), ['cpp', 'py', 'js', 'rs']);
    assert.deepEqual(normalizeExtensions([]), []);
    for (const value of [null, [''], ['../py'], ['*.cpp'], ['py/js'], ['tar.gz'], [123]]) assert.throws(() => normalizeExtensions(value), /확장자/);
});
