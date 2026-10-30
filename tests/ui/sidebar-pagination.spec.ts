import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';

const logs = Array.from({ length: 55 }, (_, i) => ({
    fileName: `solve${i}.cpp`, filePath: `/work/solve${i}.cpp`, language: 'cpp', lastModified: Date.now() - i * 1000,
}));
async function send(page: Page, data: object) {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
}
async function state(page: Page, recentLogs = logs.slice(0, 20), recentLogsRevision = 1, hasMoreRecentLogs = true) {
    await send(page, { type: 'updateState', root: '/work', isRecording: true, languages: ['cpp'], recentLogs, recentLogsRevision, hasMoreRecentLogs });
}
async function requests(page: Page) {
    return page.evaluate(() => (window as any).__messages.filter((m: any) => m.type === 'loadMoreLogs'));
}
async function scrollEnd(page: Page) {
    await page.locator('#logs-container').evaluate(el => { el.scrollTop = el.scrollHeight; });
}
async function settle(page: Page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
const rows = (page: Page) => page.locator('#logs-container .log-item');

test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 650 });
    await openWebview(page, true);
});

test('scrolling loads successive pages once, keeps the heading fixed, and stops at the end', async ({ page }) => {
    await state(page);
    await expect(rows(page)).toHaveCount(20);
    await settle(page);
    expect(await requests(page)).toHaveLength(0);
    const heading = await page.locator('#recent-logs-title').boundingBox();
    await scrollEnd(page);
    await expect.poll(async () => (await requests(page)).length).toBe(1);
    await expect(page.locator('#logs-container')).toHaveAttribute('aria-busy', 'true');
    await page.locator('#logs-container').evaluate(el => {
        for (let i = 0; i < 5; i++) el.dispatchEvent(new Event('scroll'));
    });
    await settle(page);
    expect(await requests(page)).toEqual([{ type: 'loadMoreLogs', requestId: 1, count: 20, searchId: 0 }]);
    await send(page, { type: 'recentLogsPage', requestId: 1, recentLogs: logs.slice(0, 40), hasMoreRecentLogs: true, recentLogsRevision: 2 });
    await expect(rows(page)).toHaveCount(40);
    await scrollEnd(page);
    await expect.poll(async () => (await requests(page)).length).toBe(2);
    await send(page, { type: 'recentLogsPage', requestId: 2, recentLogs: logs, hasMoreRecentLogs: false, recentLogsRevision: 3 });
    await expect(rows(page)).toHaveCount(55);
    await scrollEnd(page);
    await settle(page);
    expect(await requests(page)).toHaveLength(2);
    expect(await rows(page).evaluateAll(elements => elements.map(el => (el as HTMLElement).dataset.path))).toEqual(logs.map(log => log.filePath));
    expect(await page.locator('#recent-logs-title').boundingBox()).toEqual(heading);
    await expect(page.locator('#recent-logs-loader')).toBeHidden();
    await rows(page).last().dblclick();
    expect(await page.evaluate(() => (window as any).__messages.at(-1))).toEqual({ type: 'openFile', path: '/work/solve54.cpp' });
});

test('new records preserve the visible position and selection while delayed pages cannot rewind the list', async ({ page }) => {
    await state(page);
    await scrollEnd(page);
    await expect.poll(async () => (await requests(page)).length).toBe(1);
    const selected = rows(page).filter({ hasText: 'solve19.cpp' });
    await selected.click();
    await page.keyboard.press('Escape');
    const before = await selected.boundingBox();
    const added = { ...logs[0], fileName: 'new.cpp', filePath: '/work/new.cpp' };
    await state(page, [added, ...logs.slice(0, 40)], 3);
    await expect(rows(page)).toHaveCount(41);
    expect(await selected.boundingBox()).toEqual(before);
    await expect(selected).toHaveAttribute('aria-pressed', 'true');
    await send(page, { type: 'recentLogsPage', requestId: 1, recentLogs: logs.slice(0, 40), hasMoreRecentLogs: true, recentLogsRevision: 2 });
    await expect(page.locator('#logs-container')).toHaveAttribute('aria-busy', 'false');
    await expect(rows(page)).toHaveCount(41);
    await state(page, logs.slice(0, 20), 1);
    await expect(rows(page)).toHaveCount(41);
    expect(await selected.boundingBox()).toEqual(before);
    await page.locator('#generate-blog-btn').click();
    expect(await page.evaluate(() => (window as any).__messages.at(-1))).toEqual({ type: 'generateBlog', path: '/work/solve19.cpp' });
});

test('failed loading keeps existing rows and retries only on request', async ({ page }) => {
    await state(page);
    await scrollEnd(page);
    await expect.poll(async () => (await requests(page)).length).toBe(1);
    await send(page, { type: 'recentLogsPage', requestId: 1, error: '이전 기록을 불러오지 못했습니다.' });
    await expect(rows(page)).toHaveCount(20);
    await expect(page.getByRole('button', { name: '다시 불러오기' })).toBeVisible();
    await scrollEnd(page);
    await settle(page);
    expect(await requests(page)).toHaveLength(1);
    await page.getByRole('button', { name: '다시 불러오기' }).click();
    await expect.poll(async () => (await requests(page)).length).toBe(2);
    expect((await requests(page))[1]).toEqual({ type: 'loadMoreLogs', requestId: 2, count: 20, searchId: 0 });
    await send(page, { type: 'recentLogsPage', requestId: 2, recentLogs: logs.slice(0, 40), hasMoreRecentLogs: true, recentLogsRevision: 2 });
    await expect(rows(page)).toHaveCount(40);
    await expect(page.locator('#retry-logs-btn')).toBeHidden();
    await expect(page.locator('#logs-container')).toHaveAttribute('aria-busy', 'false');
});

test('a tall viewport fills automatically and empty history makes no extra requests', async ({ page }) => {
    await state(page, [], 1, false);
    await expect(page.locator('.empty-logs')).toBeVisible();
    await settle(page);
    expect(await requests(page)).toHaveLength(0);
    await state(page, logs.slice(0, 20), 2);
    await page.setViewportSize({ width: 300, height: 2500 });
    await expect.poll(async () => (await requests(page)).length).toBe(1);
    await send(page, { type: 'recentLogsPage', requestId: 1, recentLogs: logs.slice(0, 40), hasMoreRecentLogs: true, recentLogsRevision: 3 });
    await expect.poll(async () => (await requests(page)).length).toBe(2);
    await send(page, { type: 'recentLogsPage', requestId: 2, recentLogs: logs, hasMoreRecentLogs: false, recentLogsRevision: 4 });
    await expect(rows(page)).toHaveCount(55);
    await settle(page);
    expect(await requests(page)).toHaveLength(2);
});
