import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { computeDiff, getHash } from '../storage/utils';
import { FileHistory } from '../types';
import { HistoryRenderer } from '../services/HistoryRenderer';
import { HistoryStream, reverseHistory } from '../services/HistoryStream';

function history(contents: string[]): FileHistory {
    return { id: 'test', filePath: '/work/2527.cpp', language: 'cpp', startedAt: 1, lastModified: 2, requestLogs: [],
        snapshots: contents.map((content, i) => {
            const patch = i && computeDiff(contents[i - 1], content);
            return { timestamp: i + 1, hash: getHash(content), ...(patch ? { diff: patch } : { content }) };
        }) };
}
const plain = async (code: string) => `<pre><code>${code}</code></pre>`;

test('reverse history restores every full/diff version, including deletions, Unicode and empty files', async () => {
    const contents = ['', '가😀\r\nint a;', '가😀\r\nint ab;', 'x'.repeat(700), 'x'.repeat(3), '', '끝'];
    const source = history(contents), original = JSON.stringify(source);
    const result = [];
    for await (const pair of reverseHistory(source)) {
        result.push(pair.index);
        assert.equal(pair.current, contents[pair.index]);
        assert.equal(pair.previous, contents[pair.index - 1] ?? '');
    }
    assert.deepEqual(result, contents.map((_, i) => i).reverse());
    assert.equal(JSON.stringify(source), original);
});

test('354 versions stream newest first and highlight each adjacent version only once', async () => {
    const contents = Array.from({ length: 354 }, (_, i) => `int value = ${i};\n`);
    let highlights = 0;
    const stream = new HistoryStream(history(contents), new HistoryRenderer(async code => { highlights++; return plain(code); }));
    assert.equal(highlights, 0);
    const indices = [];
    while (true) {
        const entry = await stream.next();
        if (!entry) break;
        assert.match(entry.rows, /diff-line/);
        if (entry.complete) indices.push(entry.index);
    }
    assert.deepEqual(indices, contents.map((_, i) => i).reverse());
    assert.equal(highlights, 354);
});

test('large entries are delivered in bounded row batches without losing rows', async () => {
    const source = Array.from({ length: 4000 }, (_, i) => `int item${i};`).join('\n');
    const stream = new HistoryStream(history([source]), new HistoryRenderer(async () => { throw new Error('large code should skip highlighting'); }));
    let rows = 0, headers = 0, completed = 0, chunks = 0;
    for (let part = await stream.next(); part; part = await stream.next()) {
        const count = (part.rows.match(/class="diff-line diff-added"/g) ?? []).length;
        assert.ok(count <= 40);
        assert.ok(part.rows.length <= 32 * 1024);
        rows += count; chunks++; headers += Number(!!part.html); completed += Number(part.complete);
    }
    assert.equal(rows, 4000); assert.equal(headers, 1); assert.equal(completed, 1); assert.ok(chunks > 1);
});

test('closed streams discard in-flight work and do not highlight subsequent versions', async () => {
    let release!: () => void, entered!: () => void, highlights = 0;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const stream = new HistoryStream(history(['a', 'b', 'c']), new HistoryRenderer(async code => {
        highlights++; entered(); await new Promise<void>(resolve => { release = resolve; }); return plain(code);
    }));
    const work = stream.next();
    await waiting; stream.dispose(); release();
    assert.equal(await work, undefined);
    assert.equal(await stream.next(), undefined);
    assert.equal(highlights, 1);
});

test('empty initial files remain visible, latest versions cannot be deleted, and failed highlighting escapes code', async () => {
    const renderer = new HistoryRenderer(async () => { throw new Error('unavailable'); });
    const empty = await renderer.render(history(['']), 0, '', '');
    assert.match(empty!.chunks.join(''), /빈 파일/);
    assert.doesNotMatch(empty!.html, /delete-btn/);
    const injection = '<script>alert("x")</script>';
    const result = await renderer.render(history([injection]), 0, injection, '');
    assert.doesNotMatch(result!.chunks.join(''), /<script>/);
    assert.match(result!.chunks.join(''), /&lt;script&gt;/);
});

test('the first visible change needs neither highlighting nor the history before its nearest full snapshot', async () => {
    const source = history(['unused', '---', 'old', '<img src=x>$&', '<img src=x>$&+']);
    source.snapshots[3] = { content: '<img src=x>$&', hash: '', timestamp: 4 };
    source.snapshots[4] = { diff: { start: 13, end: 13, newText: '+' }, hash: '', timestamp: 5 };
    Object.defineProperty(source.snapshots, 2, { get() { throw new Error('older history read'); } });
    let highlights = 0;
    const stream = new HistoryStream(source, new HistoryRenderer(async () => { highlights++; throw new Error('no colors'); }));
    const preview = await stream.preview();
    assert.equal(highlights, 0);
    assert.match(preview!.rows, /&lt;img src=x&gt;\$&amp;\+/);
    assert.doesNotMatch(preview!.rows, /<img/);
    const styled = await stream.next();
    assert.equal(styled!.index, 4);
    assert.equal(styled!.rows, preview!.rows);
    assert.equal(highlights, 2);
    stream.dispose();
});

test('only three context lines on each side of distant changes survive in the preview and styled entry', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => String(i));
    const edited = [...lines]; edited[8] = 'eight'; edited[21] = 'twenty-one';
    const stream = new HistoryStream(history([lines.join('\n'), edited.join('\n')]), new HistoryRenderer(plain));
    const preview = await stream.preview();
    const styled = await stream.next();
    assert.equal(styled!.rows, preview!.rows);
    assert.equal((preview!.rows.match(/diff-unchanged/g) ?? []).length, 12);
    assert.equal((preview!.rows.match(/diff-separator/g) ?? []).length, 1);
    stream.dispose();
});
