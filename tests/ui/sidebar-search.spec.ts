import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';

const logs = Array.from({ length: 55 }, (_, i) => ({
    fileName: `solve${i}.cpp`, filePath: `/work/solve${i}.cpp`, language: 'cpp', lastModified: Date.now() - i * 1000,
}));
const rows = (page: Page) => page.locator('#logs-container .log-item');
const input = (page: Page) => page.getByRole('searchbox', { name: '파일명 또는 경로 검색' });
const toggle = (page: Page) => page.getByRole('button', { name: '기록 검색', exact: true });
async function send(page: Page, data: object) {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
}
async function requests(page: Page, type = 'searchLogs') {
    return page.evaluate(type => (window as any).__messages.filter((m: any) => m.type === type), type);
}
async function reply(page: Page, request: any, recentLogs: typeof logs, more = false, revision = request.requestId + 10) {
    await send(page, { type: 'recentLogsPage', requestId: request.requestId, recentLogsSearchId: request.searchId, recentLogs, hasMoreRecentLogs: more, recentLogsRevision: revision });
}
async function settle(page: Page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 650 });
    await openWebview(page, true);
    await send(page, { type: 'updateState', root: '/work', isRecording: true, languages: ['cpp'], recentLogs: logs.slice(0, 20), recentLogsRevision: 1, recentLogsSearchId: 0, hasMoreRecentLogs: true });
});

test('header search finds an older file and clearing resets an expanded list to 20', async ({ page }) => {
    await expect(input(page)).toBeHidden();
    const title = (await page.locator('#recent-logs-title').boundingBox())!;
    const button = (await toggle(page).boundingBox())!;
    expect(button.x).toBeGreaterThan(title.x + title.width);
    expect(button.y + button.height / 2).toBeCloseTo(title.y + title.height / 2, 1);
    await page.locator('#logs-container').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(async () => (await requests(page, 'loadMoreLogs')).length).toBe(1);
    await reply(page, (await requests(page, 'loadMoreLogs'))[0], logs.slice(0, 40), true);
    await expect(rows(page)).toHaveCount(40);
    await toggle(page).click();
    await expect(input(page)).toBeFocused();
    expect((await input(page).boundingBox())!.y).toBeGreaterThanOrEqual(button.y + button.height);
    expect(await requests(page)).toHaveLength(0);
    await input(page).fill('solve54');
    await expect.poll(async () => (await requests(page)).length).toBe(1);
    const search = (await requests(page))[0];
    expect(search).toMatchObject({ query: 'solve54', searchId: 1 });
    await reply(page, search, [logs[54]]);
    await expect(rows(page)).toHaveCount(1);
    await rows(page).first().dblclick();
    expect(await page.evaluate(() => (window as any).__messages.at(-1))).toEqual({ type: 'openFile', path: '/work/solve54.cpp' });
    await input(page).fill('');
    await expect.poll(async () => (await requests(page)).length).toBe(2);
    const clear = (await requests(page))[1];
    expect(clear).toMatchObject({ query: '', searchId: 2 });
    await reply(page, clear, logs.slice(0, 20), true);
    await expect(rows(page)).toHaveCount(20);
    expect(await page.locator('#logs-container').evaluate(el => el.scrollTop)).toBe(0);
    await page.locator('#logs-container').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(async () => (await requests(page, 'loadMoreLogs')).length).toBe(2);
    const more = (await requests(page, 'loadMoreLogs'))[1];
    expect(more).toMatchObject({ count: 20, searchId: 2 });
    await reply(page, more, logs.slice(0, 40), true);
    await expect(rows(page)).toHaveCount(40);
});

test('late pages and repeated search terms cannot replace the current search', async ({ page }) => {
    await toggle(page).click();
    for (const [i, query] of ['solve5', 'solve54', 'solve5'].entries()) {
        await input(page).fill(query);
        await expect.poll(async () => (await requests(page)).length).toBe(i + 1);
    }
    const [old, other, current] = await requests(page);
    await reply(page, current, [logs[5], ...logs.slice(50)], false, 5);
    await reply(page, old, [logs[5]], false, 100);
    await reply(page, other, [logs[54]], false, 101);
    await send(page, { type: 'updateState', root: '/work', isRecording: true, languages: ['cpp'], recentLogs: logs.slice(0, 40), recentLogsSearchId: 0, recentLogsRevision: 102, hasMoreRecentLogs: true });
    await expect(rows(page)).toHaveCount(6);
    await input(page).press('Escape');
    await expect(input(page)).toBeHidden();
    await expect(toggle(page)).toBeFocused();
    const clear = (await requests(page)).at(-1);
    await reply(page, clear, logs.slice(0, 20), true, 103);
    await reply(page, current, [logs[5]], false, 104);
    await expect(rows(page)).toHaveCount(20);
});

test('empty and failed searches do not generate a post for an unrelated file', async ({ page }) => {
    await toggle(page).click();
    await input(page).fill('missing');
    await expect.poll(async () => (await requests(page)).length).toBe(1);
    const first = (await requests(page))[0];
    await send(page, { type: 'recentLogsPage', requestId: first.requestId, recentLogsSearchId: first.searchId, error: '기록을 불러오지 못했습니다.' });
    await expect(page.locator('#generate-blog-btn')).toBeDisabled();
    await page.getByRole('button', { name: '다시 불러오기' }).click();
    const retry = (await requests(page)).at(-1);
    expect(retry).toMatchObject({ query: 'missing', searchId: first.searchId });
    await reply(page, retry, []);
    await expect(page.getByText('검색 결과가 없습니다.', { exact: true })).toBeVisible();
    await expect(page.locator('#generate-blog-btn')).toBeDisabled();
    await input(page).fill('');
    await reply(page, (await requests(page)).at(-1), logs.slice(0, 20), true);
    await expect(page.locator('#generate-blog-btn')).toBeEnabled();
});

test('Korean composition waits for completed input before searching', async ({ page }) => {
    await toggle(page).click();
    await input(page).evaluate(el => {
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        (el as HTMLInputElement).value = '풀이';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    // Allow the ordinary search debounce to expire while IME composition remains active.
    await page.waitForTimeout(200);
    expect(await requests(page)).toHaveLength(0);
    await input(page).evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '풀이' })));
    await expect.poll(async () => (await requests(page)).length).toBe(1);
    expect((await requests(page))[0].query).toBe('풀이');
});

test('clearing in a tall viewport keeps exactly 20 until the next scroll gesture', async ({ page }) => {
    await toggle(page).click();
    await input(page).fill('missing');
    await expect.poll(async () => (await requests(page)).length).toBe(1);
    await reply(page, (await requests(page))[0], []);
    await page.setViewportSize({ width: 300, height: 2500 });
    await input(page).fill('');
    await reply(page, (await requests(page)).at(-1), logs.slice(0, 20), true);
    await settle(page);
    await expect(rows(page)).toHaveCount(20);
    expect(await requests(page, 'loadMoreLogs')).toHaveLength(0);
    await page.locator('#logs-container').hover();
    await page.mouse.wheel(0, 300);
    await expect.poll(async () => (await requests(page, 'loadMoreLogs')).length).toBe(1);
});
