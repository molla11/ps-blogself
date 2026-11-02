import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DraftStore } from '../writing/DraftStore';
import { newDraft, articleVersionKey, mergeResult, WritingDraft } from '../writing/model';
import { registerGeneratedArticles, writingActivityContent, WritingActivityStore } from '../writing/WritingActivity';

const history = { id: 'test', filePath: '/work/solve.py', language: 'py', startedAt: 1, lastModified: 2,
    snapshots: [{ timestamp: 1, content: 'print(1)', hash: 'a' }, { timestamp: 2, content: 'print(2)', hash: 'b' }], requestLogs: [] };
function draft() {
    const value = newDraft(history);
    value.plan = { title: '제목', summary: '전체 설명', start: 0, end: 1,
        steps: [{ title: '시작', body: '첫 메모', start: 0, end: 0 }, { title: '수정', body: '다음 메모', start: 1, end: 1 }] };
    value.title = '현재 글'; value.markdown = '글 본문';
    value.articleVersions = [{ title: '예전 글', markdown: '예전 본문', at: 1 }];
    return value;
}
function generate(value: WritingDraft, title: string, markdown: string, baseRevision = value.revision) {
    const previous = writingActivityContent(value).articles;
    mergeResult(value, { title, markdown }, baseRevision);
    registerGeneratedArticles(value, previous);
}
test('counts each prepared note bundle once and distinct articles, including a new unapplied result', () => {
    assert.deepEqual(writingActivityContent(newDraft(history)), { notes: [], articles: [], newArticles: [], visible: { notes: [], articles: [] } });
    const value = draft();
    value.articleVersions.push({ title: value.title, markdown: value.markdown + '  \n', at: 2 });
    let content = writingActivityContent(value);
    assert.equal(content.notes.length, 1); assert.equal(content.articles.length, 2);
    const plan = value.plan!;
    value.plan = { steps: plan.steps.map(step => ({ end: step.end, start: step.start, body: step.body + '  \n', title: step.title })),
        end: plan.end, start: plan.start, summary: plan.summary + '\r\n', title: plan.title };
    assert.deepEqual(writingActivityContent(value).notes, content.notes, 'whitespace and property order do not create an unread bundle');
    value.candidate = { title: '새 글', markdown: '새 본문', plan: { ...value.plan!, summary: '새 전체 설명' } };
    content = writingActivityContent(value);
    assert.equal(content.notes.length, 2); assert.equal(content.articles.length, 3);
    assert.equal(content.visible.notes.length, 1); assert.equal(content.visible.articles.length, 1);
    delete value.candidate;
    value.plan!.steps[0].body = '  ';
    value.plan!.start = 0; value.plan!.end = 0;
    assert.equal(writingActivityContent(value).notes.length, 1);
});

async function setup(run: (store: DraftStore, activity: WritingActivityStore, other: WritingActivityStore, dir: string) => Promise<void>) {
    const dir = await mkdtemp(path.join(tmpdir(), 'psb-activity-'));
    const store = new DraftStore(path.join(dir, 'drafts'));
    const create = () => new WritingActivityStore(path.join(dir, 'viewed.json'), file => store.read(file), (file, changed) => store.watch(file, changed), () => {});
    const activity = create(), other = create();
    try { await run(store, activity, other, dir); }
    finally { activity.dispose(); other.dispose(); await store.close(); await rm(dir, { recursive: true, force: true }); }
}
test('only new generated articles notify, and read receipts survive reopening without changing the editing lease', () => setup(async (store, activity, other, dir) => {
    const value = await store.open(draft());
    assert.deepEqual(await activity.summary(value.filePath), { notes: 1, articles: 2, unreadArticles: false });
    generate(value, '새 글 1', '새 본문 1');
    const first = articleVersionKey(value);
    generate(value, '새 글 2', '새 본문 2');
    await store.save(value); activity.update(value);
    assert.equal((await activity.summary(value.filePath)).unreadArticles, true);
    const reopened = new WritingActivityStore(path.join(dir, 'viewed.json'), file => store.read(file), (file, changed) => store.watch(file, changed), () => {});
    assert.equal((await reopened.summary(value.filePath)).unreadArticles, true);
    await Promise.all([
        activity.markViewed(value.filePath, { notes: [], articles: [first] }),
        other.markViewed(value.filePath, { notes: [], articles: [articleVersionKey(value)] }),
    ]);
    try {
        await reopened.markViewed(value.filePath, { notes: [], articles: [first] });
        assert.deepEqual(await reopened.summary(value.filePath), { notes: 1, articles: 4, unreadArticles: false });
        assert.equal((await reopened.summary(value.filePath)).unreadArticles, false);
        const stored = await store.read(value.filePath);
        assert.equal(stored!.storageVersion, value.storageVersion);
        assert.deepEqual(stored!.editor, value.editor);
        value.plan!.steps[0].body = '아직 보지 않은 새 메모';
        await store.save(value);
        reopened.update(value);
        assert.deepEqual(await reopened.summary(value.filePath), { notes: 1, articles: 4, unreadArticles: false });
        await reopened.markViewed(value.filePath, { notes: ['f'.repeat(64)], articles: [] });
        assert.equal((await reopened.summary(value.filePath)).unreadArticles, false);
    } finally { reopened.dispose(); }
}));

test('another window sees saved content and read receipts without creating a draft for empty rows', () => setup(async (store, activity, other) => {
    assert.deepEqual(await activity.summary(history.filePath), { notes: 0, articles: 0, unreadArticles: false });
    assert.equal(await store.read(history.filePath), undefined);
    const value = await store.open(draft());
    const until = async (check: () => Promise<boolean>) => {
        for (let i = 0; i < 60; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
        assert.fail('Cross-window activity did not refresh');
    };
    await until(async () => (await activity.summary(history.filePath)).notes === 1);
    assert.equal((await activity.summary(history.filePath)).unreadArticles, false);
    generate(value, '새 글', '새 본문');
    await store.save(value);
    await until(async () => (await activity.summary(history.filePath)).unreadArticles);
    await other.markViewed(history.filePath, writingActivityContent(value));
    await until(async () => !(await activity.summary(history.filePath)).unreadArticles);
}));

test('legacy content, edits, restored versions and repeated generated content do not become new-article notifications', () => {
    const value = draft();
    assert.deepEqual(writingActivityContent(value).newArticles, []);
    value.markdown = '직접 수정한 기존 글';
    mergeResult(value, value.articleVersions[0], value.revision);
    assert.deepEqual(writingActivityContent(value).newArticles, []);
    generate(value, value.title + '  ', value.markdown + '  \n');
    assert.deepEqual(writingActivityContent(value).newArticles, []);
    generate(value, '새 후보', '아직 적용하지 않은 새 글', value.revision - 1);
    const pending = writingActivityContent(value).newArticles;
    assert.equal(pending.length, 1);
    mergeResult(value, value.candidate!, value.revision);
    delete value.candidate;
    assert.deepEqual(writingActivityContent(value).newArticles, pending);
});
