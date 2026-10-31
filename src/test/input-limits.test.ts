import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { validateRequest } from '../writing/RequestValidation';
import { WritingRequest, sourceFor, writingSourceFor, preparationSource } from '../writing/model';
import { MAX_CODE_BYTES, MAX_RECONSTRUCTED_BYTES, utf8Bytes } from '../writing/InputLimits';
import { limitedSnapshotText } from '../storage/SnapshotLimit';

const request: WritingRequest = { requestId: 'guard-local', kind: 'prepare_blog', instructions: '',
    source: { fileName: 'solve.c', language: 'c', initialCode: '', finalCode: 'int main(){}', changes: [{ index: 0, at: new Date().toISOString(), diff: '+int main(){}' }] } };
test('recording rejects oversized documents before reading and counts UTF-8 bytes exactly', () => {
    let reads = 0;
    assert.equal(limitedSnapshotText(MAX_CODE_BYTES + 1, () => { reads++; return ''; }), undefined);
    assert.equal(reads, 0);
    for (const size of [MAX_CODE_BYTES - 1, MAX_CODE_BYTES]) assert.equal(limitedSnapshotText(size, () => 'x'.repeat(size))?.length, size);
    assert.equal(limitedSnapshotText(undefined, () => 'x'.repeat(MAX_CODE_BYTES + 1)), undefined);
    assert.equal(limitedSnapshotText(200000, () => '가'.repeat(200000)), undefined);
    assert.equal(limitedSnapshotText(200000, () => '😀'.repeat(100000))?.length, 200000);
    assert.doesNotThrow(() => validateRequest({ ...request, source: { ...request.source, finalCode: 'x'.repeat(MAX_CODE_BYTES) } }));
    assert.throws(() => validateRequest({ ...request, source: { ...request.source, finalCode: 'x'.repeat(MAX_CODE_BYTES + 1) } }), { code: 'INPUT_TOO_LARGE' });
    const history = { id: 'legacy', filePath: '/large.c', language: 'c', startedAt: 0, lastModified: 0, requestLogs: [], snapshots: [{ content: 'x'.repeat(MAX_CODE_BYTES + 1), timestamp: 0, hash: 'legacy' }] };
    assert.equal(sourceFor(history).finalCode.length, MAX_CODE_BYTES + 1); // Old records stay viewable.
    assert.throws(() => writingSourceFor(history), { code: 'INPUT_TOO_LARGE' });
});
test('automatic preparation narrows a long history to the server reconstruction budget', () => {
    const snapshots = Array.from({ length: 12 }, (_, index) => ({ content: '// ' + 'x'.repeat(400000) + `\nint a=${index};\n`, timestamp: index, hash: String(index) }));
    const history = { id: 'long', filePath: '/long.c', language: 'c', startedAt: 0, lastModified: 11, requestLogs: [], snapshots };
    assert.throws(() => writingSourceFor(history), { code: 'INPUT_TOO_LARGE' });
    const source = preparationSource(history);
    assert.ok(source.changes[0].index > 0);
    assert.equal(source.finalCode, snapshots.at(-1)!.content);
    assert.ok(source.changes.reduce((total, c) => total + utf8Bytes(snapshots[c.index].content), 0) <= MAX_RECONSTRUCTED_BYTES);
    assert.equal(history.snapshots.length, 12);
});
