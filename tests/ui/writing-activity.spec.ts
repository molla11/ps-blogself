import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';
const post = (page: Page, data: unknown) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
const note = 'a'.repeat(64), article = 'b'.repeat(64), older = 'c'.repeat(64);

test('file rows show only positive counts, unread markers and live updates without disturbing the menu', async ({ page }) => {
    await page.setViewportSize({ width: 280, height: 700 });
    await openWebview(page, true);
    const logs = [
        { filePath: '/work/empty.cpp', fileName: 'empty.cpp', language: 'cpp', lastModified: 1 },
        { filePath: '/work/notes.py', fileName: '아주 긴 이름의 알고리즘 풀이 메모.py', language: 'py', lastModified: 2,
            writingActivity: { notes: 1, articles: 0, unreadNotes: true, unreadArticles: false } },
        { filePath: '/work/article.cpp', fileName: 'article.cpp', language: 'cpp', lastModified: 3,
            writingActivity: { notes: 1, articles: 3, unreadNotes: false, unreadArticles: true } },
    ];
    await post(page, { type: 'updateState', root: '', languages: ['cpp', 'py'], recentLogs: logs });
    const rows = page.locator('.log-item');
    await expect(rows.nth(0).locator('.log-writing')).toBeHidden();
    await expect(rows.nth(1).locator('.log-writing')).toHaveText('메모 1');
    await expect(rows.nth(1).locator('.log-unread')).toHaveCount(0);
    await expect(rows.nth(1).locator('.log-writing-count')).toHaveAttribute('aria-label', '메모 1개');
    await expect(rows.nth(2).locator('.log-writing-count')).toHaveText(['메모 1', '글 3']);
    await expect(rows.nth(2).locator('[aria-label="글 3개 · 확인하지 않은 내용이 있습니다."]')).toBeVisible();
    const info = (await rows.nth(1).locator('.log-info').boundingBox())!, counts = (await rows.nth(1).locator('.log-writing').boundingBox())!;
    expect(info.x + info.width).toBeLessThan(counts.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(280);
    await rows.nth(1).locator('.log-writing').click();
    await expect(page.locator('#context-menu')).toBeVisible();
    await post(page, { type: 'writingActivity', filePath: logs[1].filePath, writingActivityRevision: 2,
        writingActivity: { notes: 1, articles: 0, unreadNotes: false, unreadArticles: false } });
    await expect(rows.nth(1).locator('.log-unread')).toHaveCount(0);
    await expect(page.locator('#context-menu')).toBeVisible();
    await post(page, { type: 'updateState', root: '', languages: ['cpp', 'py'], recentLogs: logs });
    await expect(rows.nth(1).locator('.log-unread')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: 'test-results/sidebar-writing-activity.png' });
    await post(page, { type: 'writingActivity', filePath: logs[2].filePath, writingActivityRevision: 3,
        writingActivity: { notes: 0, articles: 0, unreadNotes: false, unreadArticles: false } });
    await expect(rows.nth(2).locator('.log-writing')).toBeHidden();
    expect(await page.evaluate(() => (window as any).__messages.some((m: any) => m.type === 'viewedWriting'))).toBe(false);
});

const base = { type: 'model', filePath: '/work/notes.py', fileName: 'notes.py', editable: true, editToken: 'window-a',
    instructions: '', title: '', markdown: '', count: 1, times: [1], versions: [], pending: false, running: false, progress: 100,
    status: '', error: '', candidate: false, plan: { title: '제목', summary: '전체 설명', start: 0, end: 0, steps: [] },
    activity: { notes: [note], articles: [] } };
async function viewed(page: Page) { return page.evaluate(() => (window as any).__messages.filter((m: any) => m.type === 'viewedWriting')); }
test('notes never send read receipts; only displayed article versions become read while background updates stay unread', async ({ page }) => {
    await openWebview(page);
    await post(page, { ...base, writingVisible: false });
    // Let both the render and its read-ack frame complete while the window is inactive.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await viewed(page)).toEqual([]);
    await post(page, { type: 'writingVisibility', visible: true });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await viewed(page)).toEqual([]);
    await post(page, { ...base, title: '글', markdown: '본문', activity: { notes: [note], articles: [article] },
        versions: [{ id: older, title: '예전 글', at: 1 }] });
    await expect.poll(() => viewed(page)).toHaveLength(1);
    expect((await viewed(page))[0]).toMatchObject({ notes: [], articles: [article] });
    await page.locator('#version-select').selectOption(older);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await viewed(page)).toHaveLength(1);
    await post(page, { type: 'versionPreview', versionId: older, title: '예전 글', html: '<p>이전 본문</p>' });
    await expect.poll(() => viewed(page)).toHaveLength(2);
    expect((await viewed(page))[1]).toMatchObject({ notes: [], articles: [older] });
    await post(page, { ...base, title: '글', markdown: '본문', writingVisible: false,
        activity: { notes: ['d'.repeat(64)], articles: ['e'.repeat(64)] } });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await viewed(page)).toHaveLength(2);
    await post(page, { type: 'writingVisibility', visible: true });
    await expect.poll(() => viewed(page)).toHaveLength(3);
    expect((await viewed(page))[2]).toMatchObject({ notes: [], articles: ['e'.repeat(64)] });
});

test('unsaved article edits do not acknowledge different server content hidden behind those edits', async ({ page }) => {
    await openWebview(page);
    await post(page, { ...base, writingVisible: false, title: '제목', markdown: '기존 본문' });
    await page.locator('#source-btn').click();
    await page.locator('#article-body').fill('직접 편집 중인 글');
    await post(page, { ...base, writingVisible: true, title: '제목', markdown: '새 서버 글',
        activity: { notes: [note], articles: ['d'.repeat(64)] } });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#article-body')).toHaveValue('직접 편집 중인 글');
    expect(await viewed(page)).toEqual([]);
    await expect.poll(() => page.evaluate(() => (window as any).__messages.some((m: any) => m.type === 'save'))).toBe(true);
    const save = await page.evaluate(() => (window as any).__messages.find((m: any) => m.type === 'save'));
    await post(page, { type: 'ack', id: save.id });
    await post(page, { ...base, ...save.fields, activity: { notes: [note], articles: ['e'.repeat(64)] } });
    await expect.poll(() => viewed(page)).toHaveLength(1);
    expect((await viewed(page))[0]).toMatchObject({ notes: [], articles: ['e'.repeat(64)] });
});
