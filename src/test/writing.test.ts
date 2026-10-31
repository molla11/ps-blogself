import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FileHistory } from '../types';
import { computeDiff } from '../storage/utils';
import { DraftStore } from '../writing/DraftStore';
import {
    newDraft,
    reconstructContents,
    sourceFor,
    preparationSource,
    mergeResult,
    validatePlan,
    articleVersionKey,
    previousArticleVersions,
} from '../writing/model';

const history: FileHistory = {
    id: 'history',
    filePath: '/workspace/solve.py',
    language: 'python',
    startedAt: 1,
    lastModified: 3,
    requestLogs: [],
    snapshots: [
        { timestamp: 1, content: 'print(1)', hash: 'a' },
        { timestamp: 2, diff: { start: 6, end: 7, newText: '2' }, hash: 'b' },
        { timestamp: 3, content: '', hash: 'c' },
    ],
};
const plan = {
    title: '풀이 기록',
    summary: '설명',
    start: 0,
    end: 1,
    steps: [{ title: '출력 변경', body: '값을 수정했다.', start: 0, end: 1 }],
};
test('legacy patches and empty snapshots reconstruct exactly; selected input excludes later changes', () => {
    assert.deepEqual(reconstructContents(history), ['print(1)', 'print(2)', '']);
    const selected = sourceFor(history, 1, 1);
    assert.equal(selected.initialCode, 'print(1)');
    assert.equal(selected.finalCode, 'print(2)');
    assert.deepEqual(
        selected.changes.map((c) => c.index),
        [1],
    );
    assert.ok(selected.changes[0].diff.includes('+print(2)'));
    assert.throws(() => sourceFor(history, 1, 9));
});
test('a model completion cannot overwrite a newer user explanation or article', () => {
    const draft = newDraft(history);
    draft.plan = structuredClone(plan);
    const startedAt = draft.revision;
    draft.plan.summary = '내가 고친 문장';
    draft.markdown = '편집 중인 글';
    draft.revision++;
    mergeResult(draft, { plan: { ...plan, summary: 'AI 새 설명' } }, startedAt);
    assert.equal(draft.plan.summary, '내가 고친 문장');
    assert.equal(draft.candidate?.plan?.summary, 'AI 새 설명');
    mergeResult(draft, { title: 'AI 제목', markdown: '새 글' }, startedAt);
    assert.equal(draft.markdown, '편집 중인 글');
    mergeResult(draft, draft.candidate!, draft.revision);
    assert.equal(draft.markdown, '새 글');
    assert.equal(draft.articleVersions[0].markdown, '편집 중인 글');
});
test('identical articles and trailing whitespace differences do not create a version or rewrite the text', () => {
    const draft = newDraft(history);
    const original = { title: '풀이 기록', markdown: '첫 문장\n\n```python\n    print(1)\n```\n' };
    mergeResult(draft, original, draft.revision);
    for (const article of [
        original,
        { title: original.title + ' \t', markdown: '첫 문장  \r\n \t\r\n```python\r\n    print(1)\t\r\n```\r\n\r\n' },
        { ...original, markdown: original.markdown.trimEnd() },
    ]) {
        mergeResult(draft, article, draft.revision);
        assert.equal(draft.articleVersions.length, 0);
        assert.equal(draft.title, original.title);
        assert.equal(draft.markdown, original.markdown);
    }
});
test('title, words, paragraph boundaries and code indentation still distinguish versions', () => {
    const original = { title: '제목', markdown: '두 단어\n\n```py\n    print(1)\n```' };
    for (const changed of [
        { ...original, title: '새 제목' },
        { ...original, markdown: original.markdown.replace('두 단어', '두  단어') },
        { ...original, markdown: original.markdown.replace('\n\n', '\n') },
        { ...original, markdown: original.markdown.replace('    print', '  print') },
        { ...original, markdown: original.markdown.replace('1', '2') },
    ]) {
        const draft = newDraft(history);
        mergeResult(draft, original, draft.revision);
        mergeResult(draft, changed, draft.revision);
        assert.equal(draft.articleVersions.length, 1);
        assert.equal(draft.articleVersions[0].markdown, original.markdown);
        assert.equal(draft.markdown, changed.markdown);
    }
});
test('restoring or regenerating a saved article never accumulates duplicate versions', () => {
    const draft = newDraft(history);
    for (const markdown of ['A', 'B', 'A', 'B', 'A  ', 'C', 'B', 'C', 'C\n']) {
        mergeResult(draft, { title: '제목', markdown }, draft.revision);
        const keys = [draft, ...draft.articleVersions].map(articleVersionKey);
        assert.equal(new Set(keys).size, keys.length);
        assert.ok(draft.articleVersions.length <= 2);
    }
    assert.deepEqual(new Set(draft.articleVersions.map(v => v.markdown.trim())), new Set(['A', 'B']));
});
test('legacy duplicate versions are collapsed on reopen, keeping the latest timestamp and exact text', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'psb-version-test-'));
    const store = new DraftStore(directory);
    try {
        const draft = newDraft(history);
        Object.assign(draft, { title: '제목', markdown: '현재' });
        draft.articleVersions = [
            { title: '제목', markdown: '이전', at: 1 },
            { title: '제목', markdown: '현재  ', at: 2 },
            { title: '제목', markdown: '이전 \t', at: 3 },
        ];
        await store.save(draft);
        const loaded = await store.read(history.filePath);
        assert.deepEqual(loaded?.articleVersions, [{ title: '제목', markdown: '이전 \t', at: 3 }]);
        assert.equal(loaded?.markdown, '현재');
    } finally {
        await store.close();
        await rm(directory, { recursive: true, force: true });
    }
});
test('the version limit retains the latest twenty distinct previous articles', () => {
    const draft = newDraft(history);
    for (let index = 0; index < 30; index++) {
        mergeResult(draft, { title: '제목', markdown: `본문 ${index}` }, draft.revision);
        mergeResult(draft, { title: '제목', markdown: `본문 ${index}  ` }, draft.revision);
    }
    assert.deepEqual(previousArticleVersions(draft).map(v => v.markdown),
        Array.from({ length: 20 }, (_, index) => `본문 ${index + 9}`));
});
test('plans reject nonexistent ranges and malformed inputs without changing a draft', () => {
    assert.deepEqual(validatePlan(plan, 3), plan);
    assert.throws(() => validatePlan({ ...plan, end: 10 }, 3));
    assert.throws(() => validatePlan({ ...plan, steps: [{ ...plan.steps[0], start: -1 }] }, 3));
    assert.throws(() => validatePlan({ ...plan, title: '' }, 3));
});
test('durable drafts preserve edits, original history and pending jobs across reopening', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'psb-draft-test-'));
    try {
        const store = new DraftStore(directory),
            draft = newDraft(history);
        draft.plan = structuredClone(plan);
        draft.pending = {
            request: {
                requestId: 'persisted-request',
                kind: 'prepare_blog',
                source: sourceFor(history),
                instructions: '',
            },
            apiUrl: 'http://localhost:4000/api',
            baseRevision: 0,
        };
        const first = store.save(draft);
        draft.instructions = '새 입력';
        draft.revision++;
        const second = store.save(draft);
        await Promise.all([first, second]);
        const restored = await new DraftStore(directory).read(history.filePath);
        assert.equal(restored?.instructions, '새 입력');
        assert.equal(restored?.pending?.request.requestId, 'persisted-request');
        assert.deepEqual(restored?.history, history);
        assert.equal(await store.read('/different/file'), undefined);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test('small and multilingual character edits round-trip, including deletions and surrogate pairs', () => {
    for (const [before, after] of [
        ['abc', 'axc'],
        ['풀이🙂입니다', '풀이🚀입니다'],
        ['erase this', ''],
        ['a'.repeat(200), 'a'.repeat(200) + 'b'.repeat(101)],
    ]) {
        const patch = computeDiff(before, after);
        assert.ok(patch);
        assert.equal(before.slice(0, patch.start) + patch.newText + before.slice(patch.end), after);
    }
    assert.equal(computeDiff('', '가'.repeat(200)), null);
});

test('preparation bounds long histories while preserving absolute range indices', () => {
    const long = {
        ...history,
        snapshots: Array.from({ length: 600 }, (_, index) => ({
            timestamp: index + 1,
            content: 'print(' + index + ')',
            hash: String(index),
        })),
    };
    const source = preparationSource(long);
    assert.equal(source.changes.length, 400);
    assert.equal(source.changes[0].index, 200);
    assert.equal(source.initialCode, 'print(199)');
    assert.equal(source.finalCode, 'print(599)');
    assert.equal(long.snapshots.length, 600);
});
test('draft editing permits a temporarily empty title and preserves explanations outside a narrowed range', () => {
    const narrowed = { ...plan, title: '', start: 1, end: 1 };
    assert.equal(validatePlan(narrowed, 3, true).steps[0].body, plan.steps[0].body);
});
