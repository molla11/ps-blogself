import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PendingMemos } from '../writing/PendingMemos';
import * as assert from 'node:assert/strict';
import { MemoPreparationQueue, meritsAutomaticMemo, MEMO_IDLE, MEMO_COOLDOWN } from '../writing/MemoPreparation';
import { newDraft, mergeResult, preparationBaseRevision, preparationSource, appendMemoResult, memoTailStart, memoSnapshotIndex } from '../writing/model';

test('local memo eligibility ignores noise and reversions but catches short behavioral fixes', () => {
    const cpp = 'int solve(int n) { return n < 10 ? n : 10; }';
    assert.equal(meritsAutomaticMemo(cpp, ' /* a\n  long comment */\n' + cpp.replace(' < ', '<') + ' // later', 'cpp'), false);
    assert.equal(meritsAutomaticMemo(cpp, cpp, 'cpp'), false);
    assert.equal(meritsAutomaticMemo(cpp, cpp.replace('<', '<='), 'cpp'), true);
    assert.equal(meritsAutomaticMemo('for i in range(n):\n    work(i)', 'for i in range(n+1):\n    work(i)', 'python'), true);
    assert.equal(meritsAutomaticMemo('if n:\n    run()', '# header\nif n:  # ok\n  run()', 'python'), false);
    assert.equal(meritsAutomaticMemo('x = (a + b)', 'x = (a +\n  b)', 'python'), false);
    assert.equal(meritsAutomaticMemo('i = 0\nwhile i < n: i += 1', 'j = 0\nwhile j < n: j += 1', 'python'), false);
    assert.equal(meritsAutomaticMemo('value = 0', 'value = 1', 'python'), false);
    assert.equal(meritsAutomaticMemo('', '#include <iostream>\nint main() { return 0; }', 'cpp'), false);
    assert.equal(meritsAutomaticMemo('', 'from collections import deque\n# setup\nx = 1', 'python'), false);
    assert.equal(meritsAutomaticMemo('', 'seen = set()\nfor value in values:\n    if value not in seen:\n        seen.add(value)', 'python'), true);
    assert.equal(meritsAutomaticMemo('if n:\n    x()\n    work()', 'if n:\n    x()\nwork()', 'python'), true);
});

test('first meaningful edit to an existing file includes its actual starting code', () => {
    const source = preparationSource({ id: 'file', filePath: '/work/a.py', language: 'python', startedAt: 1, lastModified: 2,
        memoBaseline: 'if n < 3: work()', snapshots: [{ timestamp: 2, content: 'if n <= 3: work()', hash: 'new' }], requestLogs: [] });
    assert.equal(source.initialCode, 'if n < 3: work()');
    assert.match(source.changes[0].diff, /-if n < 3: work\(\)/);
});

test('automatic refreshes replace untouched AI memos and preserve edited or legacy memos as candidates', () => {
    const draft = newDraft({ id: 'file', filePath: '/work/a.py', language: 'python', startedAt: 1, lastModified: 1,
        snapshots: [{ timestamp: 1, hash: '1', content: 'x = 1' }], requestLogs: [] });
    const plan = { title: '제목', summary: '원래 설명', steps: [], start: 0, end: 0 };
    mergeResult(draft, { plan }, preparationBaseRevision(draft, true));
    mergeResult(draft, { plan: { ...plan, summary: '새 결과' } }, preparationBaseRevision(draft, true));
    assert.equal(draft.plan?.summary, '새 결과');
    assert.equal(preparationBaseRevision(draft, false), -1);
    draft.plan!.summary = '내가 수정한 설명';
    mergeResult(draft, { plan }, preparationBaseRevision(draft, true));
    assert.equal(draft.plan!.summary, '내가 수정한 설명');
    assert.equal(draft.candidate?.plan?.summary, '원래 설명');
    delete draft.preparedPlanHash;
    assert.equal(preparationBaseRevision(draft, true), -1);
});

test('rapid edits are folded into a single patch between checkpoints with the original indices', () => {
    const versions = ['x = 1', 'x = 12', 'x = 123', 'total = sum(values) + x'];
    const history = { id: 'x', filePath: 'a.py', language: 'python', startedAt: 0, lastModified: 3, requestLogs: [],
        snapshots: versions.map((content, i) => ({ timestamp: i * 1000, content, hash: String(i) })) };
    const automatic = preparationSource(history, true);
    assert.deepEqual(automatic.changes.map(s => s.index), [0, 3]);
    assert.equal(automatic.finalCode, versions[3]);
    assert.deepEqual(preparationSource(history).changes.map(s => s.index), [0, 1, 2, 3]);
});

test('a restarted window recovers pending files and cannot erase newer work recorded in another window', async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'psb-memos-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const open = () => new PendingMemos(path.join(dir, 'pending.json'), error => { throw error; });
    const first = open();
    first.mark('a.py'); first.mark('b.cpp'); await first.flush();
    const next = open();
    assert.deepEqual(await next.restore(), ['a.py', 'b.cpp']);
    next.mark('a.py'); first.finish('a.py'); first.finish('b.cpp');
    await Promise.all([first.flush(), next.flush()]);
    assert.deepEqual(await open().restore(), ['a.py']);
    next.finish('a.py'); await next.flush();
    assert.deepEqual(await open().restore(), []);
});

const tickAsync = () => new Promise<void>(resolve => setImmediate(resolve));

test('bursts coalesce, new saves survive an in-flight job and review respects its cooldown', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 500 });
    const started: string[] = [], finished: string[] = [];
    let release!: (retryAt?: number) => void;
    const queue = new MemoPreparationQueue(async file => {
        started.push(file);
        return new Promise<number | undefined>(resolve => { release = resolve; });
    }, file => finished.push(file));
    t.after(() => queue.dispose());
    queue.schedule('a'); t.mock.timers.tick(9000); queue.schedule('a'); t.mock.timers.tick(MEMO_IDLE - 1);
    assert.deepEqual(started, []);
    t.mock.timers.tick(1); assert.deepEqual(started, ['a']);
    queue.schedule('a'); queue.schedule('b', true);
    t.mock.timers.tick(16000); assert.deepEqual(started, ['a']);
    release(Date.now() + MEMO_COOLDOWN); await tickAsync(); t.mock.timers.tick(0);
    assert.deepEqual(started, ['a','b']); release(); await tickAsync();
    queue.schedule('a', true); t.mock.timers.tick(MEMO_COOLDOWN - 1); assert.deepEqual(started, ['a','b']);
    t.mock.timers.tick(1); assert.deepEqual(started, ['a','b','a']);
    queue.clear(); release(Date.now() + 5000); await tickAsync(); t.mock.timers.tick(10000);
    assert.deepEqual(started, ['a','b','a']); assert.equal(finished.at(-1), 'a');
});

test('an uninterrupted hour of edits schedules a single idle evaluation, and viewing accelerates it', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const started: string[] = [];
    const queue = new MemoPreparationQueue(async (file, review) => { started.push(file + ':' + review); }, () => {});
    t.after(() => queue.dispose());
    for (let i = 0; i < 360; i++) { queue.schedule('a'); t.mock.timers.tick(10000); }
    assert.deepEqual(started, []);
    t.mock.timers.tick(MEMO_IDLE); await tickAsync();
    assert.deepEqual(started, ['a:false']);
    queue.schedule('a'); queue.schedule('a', true); t.mock.timers.tick(0); await tickAsync();
    assert.deepEqual(started, ['a:false', 'a:true']);
    queue.schedule('b'); queue.clear(); t.mock.timers.tick(MEMO_IDLE * 2);
    assert.equal(started.length, 2);
});

test('short focus and file visits do not trigger requests, sustained departures do', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const started: string[] = [];
    const queue = new MemoPreparationQueue(async file => { started.push(file); }, () => {});
    t.after(() => queue.dispose());
    queue.setEditor('a'); queue.schedule('a'); queue.setFocus(false);
    t.mock.timers.tick(29_000); queue.setFocus(true); queue.setEditor('b');
    t.mock.timers.tick(59_000); queue.setEditor('a'); t.mock.timers.tick(1000);
    assert.deepEqual(started, []);
    queue.setEditor('b'); t.mock.timers.tick(60_000); await tickAsync();
    queue.schedule('b'); queue.setFocus(false); t.mock.timers.tick(30_000); await tickAsync();
    assert.deepEqual(started, ['a', 'b']);
});

test('incremental memos remap surviving evidence and preserve concurrent edits, including selected ranges', () => {
    const history = { id: 'f', filePath: '/p.py', language: 'python', startedAt: 0, lastModified: 1, requestLogs: [],
        snapshots: ['discard', 'a', 'b', 'a'].map((content, timestamp) => ({ content, timestamp, hash: content })) };
    const draft = newDraft(history);
    const step = { title: '내 메모', body: '직접 고친 내용', start: 1, end: 1 };
    draft.plan = { title: '직접 쓴 제목', summary: '', start: 1, end: 2, steps: [step] };
    const extended = { ...history, snapshots: [...history.snapshots.slice(1), { timestamp: 5, content: 'new', hash: 'new' }] };
    assert.equal(memoTailStart(draft, extended), 3);
    assert.equal(memoSnapshotIndex(history, extended, 3), 2);
    const source = preparationSource(extended, true, 3);
    assert.equal(source.initialCode, 'a');
    assert.deepEqual(source.changes.map(c => c.index), [3]);
    const tail = { title: '새 변경', body: '새 메모', start: 3, end: 3 };
    assert.ok(appendMemoResult(draft, extended, { ...tail, summary: '요약', steps: [tail] }));
    assert.deepEqual(draft.plan, { title: '직접 쓴 제목', summary: '', start: 0, end: 1,
        steps: [{ ...step, start: 0, end: 0 }, tail] });
    assert.equal(memoTailStart(draft, { ...extended, id: 'new file' }), undefined);
    assert.equal(memoTailStart(draft, { ...extended, snapshots: extended.snapshots.slice(1) }), undefined);
});

test('saving a checkpoint retains a reverted attempt inside a rapid batch', () => {
    const versions = ['x = a', 'x = b', 'x = a', 'print(x)'];
    const h = { id: 'x', filePath: 'a.py', language: 'python', startedAt: 0, lastModified: 3, requestLogs: [],
        snapshots: versions.map((content, i) => ({ content, hash: content, timestamp: i,
            ...(i === 1 ? { checkpoints: ['save' as const] } : {}) })) };
    const source = preparationSource(h, true);
    assert.deepEqual(source.changes.map(c => c.index), [0, 1, 3]);
    assert.equal(source.changes[1].checkpoint, true);
});

test('diagnostic-only edits are quiet while side-effecting output is kept', () => {
    const cpp = 'int main() {\n  return x;\n}';
    assert.equal(meritsAutomaticMemo(cpp, cpp.replace('  return', '  std::cerr << "value" << x << std::endl;\n  return'), 'cpp'), false);
    const py = 'count = sum(values)\nprint(count)';
    assert.equal(meritsAutomaticMemo(py, py + '\nprint("count", count, file=sys.stderr)', 'python'), false);
    assert.equal(meritsAutomaticMemo(py, py + '\nprint(queue.pop(), file=sys.stderr)', 'python'), true);
});
