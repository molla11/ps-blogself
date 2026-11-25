import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';

const requests = (page: Page) => page.evaluate(() => (window as any).__messages.filter((m: any) => m.type === 'loadHistory'));
const send = (page: Page, data: any) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
const entry = (offset: number, index: number, extra: any = {}) => ({
    type: 'historyEntry', loadId: 'test-load', offset, index, complete: true,
    html: `<div class="history-entry" data-snapshot-index="${index}"><button class="view-code-btn" data-index="${index}">이 시점의 코드 보기</button><button class="delete-btn" data-index="${index}">로그 삭제</button><table><tbody></tbody></table></div>`,
    rows: `<tr><td>version ${index + 1}</td></tr>`, ...extra,
});

test('all 354 versions load without scrolling and only one batch is requested at a time', async ({ page }) => {
    await openWebview(page, 'history');
    await expect.poll(async () => (await requests(page)).length).toBe(1);
    await page.waitForTimeout(300);
    expect((await requests(page)).length).toBe(1);
    await page.evaluate(() => {
        const state = window as any;
        state.__replyIndex = 0;
        state.__pump = setInterval(() => {
            const request = state.__messages.filter((m: any) => m.type === 'loadHistory')[state.__replyIndex];
            if (!request) return;
            const index = 353 - request.offset;
            state.__replyIndex++;
            window.dispatchEvent(new MessageEvent('message', { data: {
                type: 'historyEntry', loadId: request.loadId, offset: request.offset, index, complete: true,
                html: `<div class="history-entry" data-snapshot-index="${index}"><table><tbody></tbody></table></div>`,
                rows: `<tr><td>v${index + 1}</td></tr>`,
            } }));
        }, 1);
    });
    await expect(page.locator('.history-entry')).toHaveCount(354, { timeout: 12000 });
    await expect(page.locator('#history-progress')).toHaveText('354개 기록을 모두 불러왔습니다.');
    expect(await page.locator('.history-entry').evaluateAll(nodes => nodes.map(node => Number((node as HTMLElement).dataset.snapshotIndex)))).toEqual(Array.from({ length: 354 }, (_, i) => 353 - i));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect((await requests(page)).length).toBe(354);
});

test('stale and duplicate replies are ignored and appended snapshot buttons retain their version', async ({ page }) => {
    await openWebview(page, 'history', { total: 2 });
    await expect.poll(async () => (await requests(page)).length).toBe(1);
    await send(page, entry(0, 1, { loadId: 'old-load' }));
    await expect(page.locator('.history-entry')).toHaveCount(0);
    await send(page, entry(0, 1));
    await expect.poll(async () => (await requests(page)).length).toBe(2);
    await send(page, entry(0, 1));
    await send(page, entry(1, 0));
    await expect(page.locator('.history-entry')).toHaveCount(2);
    await page.locator('.history-entry').last().getByText('이 시점의 코드 보기').click();
    await page.locator('.history-entry').last().getByText('로그 삭제').click();
    expect(await page.evaluate(() => (window as any).__messages.filter((m: any) => ['viewSnapshot', 'deleteSnapshot'].includes(m.type)))).toEqual([
        { type: 'viewSnapshot', index: 0, version: 'test-version', loadId: 'test-load' },
        { type: 'deleteSnapshot', index: 0, version: 'test-version', loadId: 'test-load' },
    ]);
});

test('large entries append row batches, pause while hidden and resume without replacing displayed content', async ({ page }) => {
    await openWebview(page, 'history', { total: 1 });
    await expect.poll(async () => (await requests(page)).length).toBe(1);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await send(page, entry(0, 0, { complete: false }));
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('#history-progress')).toHaveText('0 / 1개 불러오는 중…');
    await page.waitForTimeout(300);
    expect((await requests(page)).length).toBe(1);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(async () => (await requests(page)).length).toBe(2);
    await send(page, entry(1, 0, { html: '', rows: '<tr><td>rest</td></tr>' }));
    await expect(page.locator('.history-entry')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(page.locator('#history-progress')).toHaveText('1개 기록을 모두 불러왔습니다.');
});

test('failed loading keeps existing entries and offers a reload', async ({ page }) => {
    await openWebview(page, 'history', { total: 2 });
    await expect.poll(async () => (await requests(page)).length).toBe(1);
    await send(page, entry(0, 1));
    await expect.poll(async () => (await requests(page)).length).toBe(2);
    await send(page, { type: 'historyError', loadId: 'test-load', offset: 1 });
    await expect(page.locator('.history-entry')).toHaveCount(1);
    await expect(page.locator('#history-progress')).toContainText('1 / 2개 표시됨');
    await page.getByRole('button', { name: '다시 불러오기' }).click();
    expect(await page.evaluate(() => (window as any).__messages.at(-1))).toEqual({ type: 'reloadHistory', loadId: 'test-load' });
});
