import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';

const logs = Array.from({ length: 30 }, (_, i) => ({
    fileName: `solve${i}.cpp`, filePath: `/work/solve${i}.cpp`, language: 'cpp', lastModified: Date.now() - i * 1000,
}));
async function update(page: Page, values = logs) {
    await page.evaluate(recentLogs => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'updateState', root: '/work', isRecording: true, languages: ['cpp', 'py'], recentLogs, totalLogSize: '10 KB',
    } })), values);
}
async function messages(page: Page) { return page.evaluate(() => (window as any).__messages); }
function row(page: Page, index: number, container = '#logs-container') { return page.locator(container + ' .log-item').filter({ has: page.getByText(`solve${index}.cpp`, { exact: true }) }); }
const menu = (page: Page) => page.getByRole('menu');

test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 650 });
    await openWebview(page, true);
    await update(page);
});

test('one click opens actions, the same row closes them, and another row switches immediately', async ({ page }) => {
    await expect(page.locator('.file-menu')).toHaveCount(0);
    await row(page, 1).click();
    await expect(menu(page)).toBeVisible();
    await expect(row(page, 1)).toHaveAttribute('aria-expanded', 'true');
    expect((await messages(page)).filter((m: any) => ['openFile', 'viewHistory'].includes(m.type))).toHaveLength(0);
    await row(page, 1).click();
    await expect(menu(page)).toBeHidden();
    await expect(row(page, 1)).toHaveAttribute('aria-expanded', 'false');
    await row(page, 1).click();
    await row(page, 0).click();
    await expect(menu(page)).toBeVisible();
    await expect(menu(page)).toHaveAttribute('aria-label', 'solve0.cpp 작업');
    await expect(row(page, 1)).toHaveAttribute('aria-expanded', 'false');
    await expect(row(page, 0)).toHaveAttribute('aria-expanded', 'true');
    await expect(row(page, 0)).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('menuitem', { name: '파일 열기', exact: true }).click();
    expect((await messages(page)).at(-1)).toEqual({ type: 'openFile', path: '/work/solve0.cpp' });
    await expect(menu(page)).toBeHidden();
});

test('native double-click opens the file exactly once from either menu state', async ({ page }) => {
    await row(page, 1).dblclick();
    await expect(menu(page)).toBeHidden();
    expect((await messages(page)).filter((m: any) => m.type === 'openFile')).toEqual([{ type: 'openFile', path: '/work/solve1.cpp' }]);
    await row(page, 0).click();
    await expect(menu(page)).toBeVisible();
    await row(page, 0).dblclick();
    await expect(menu(page)).toBeHidden();
    expect((await messages(page)).filter((m: any) => m.type === 'openFile')).toEqual([
        { type: 'openFile', path: '/work/solve1.cpp' }, { type: 'openFile', path: '/work/solve0.cpp' },
    ]);
    await row(page, 1).click();
    await row(page, 0).dblclick();
    await expect(menu(page)).toBeHidden();
    expect((await messages(page)).filter((m: any) => m.type === 'openFile')).toEqual([
        { type: 'openFile', path: '/work/solve1.cpp' }, { type: 'openFile', path: '/work/solve0.cpp' },
        { type: 'openFile', path: '/work/solve0.cpp' },
    ]);
});

test('actions open just below and right of the click without intercepting a double-click', async ({ page }) => {
    const bounds = (await row(page, 0).boundingBox())!;
    // Click different parts of the same row to distinguish pointer anchoring from row anchoring.
    for (const offset of [{ x: 20, y: 8 }, { x: 65, y: bounds.height - 8 }, { x: bounds.width - 8, y: 8 }]) {
        const point = { x: bounds.x + offset.x, y: bounds.y + offset.y };
        await page.mouse.click(point.x, point.y);
        await expect(menu(page)).toBeVisible();
        const actions = (await menu(page).boundingBox())!;
        expect(actions.y - point.y).toBeGreaterThan(0);
        expect(actions.y - point.y).toBeLessThanOrEqual(10);
        if (point.x + actions.width + 10 <= 300) {
            expect(actions.x - point.x).toBeGreaterThan(0);
            expect(actions.x - point.x).toBeLessThanOrEqual(10);
        }
        expect(actions.x + actions.width).toBeLessThanOrEqual(300);
        expect(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.closest('.log-item')?.getAttribute('data-path'), point)).toBe('/work/solve0.cpp');
        // Refreshing the list must retain the original pointer anchor.
        await update(page);
        expect(await menu(page).boundingBox()).toEqual(actions);
        await page.keyboard.press('Escape');
        await page.mouse.dblclick(point.x, point.y);
        await expect(menu(page)).toBeHidden();
    }
    expect((await messages(page)).filter((m: any) => m.type === 'openFile')).toEqual(
        Array.from({ length: 3 }, () => ({ type: 'openFile', path: '/work/solve0.cpp' })),
    );
});

test('clicking controls or blank space dismisses actions and preserves the control action', async ({ page }) => {
    await row(page, 0).click();
    await page.locator('#recent-logs-title').click();
    await expect(menu(page)).toBeHidden();
    await row(page, 1).click();
    await page.locator('#generate-blog-btn').click();
    await expect(menu(page)).toBeHidden();
    expect((await messages(page)).at(-1)).toEqual({ type: 'generateBlog', path: '/work/solve1.cpp' });
    await row(page, 1).click();
    await page.mouse.click(2, 2);
    await expect(menu(page)).toBeHidden();
});

test('keyboard actions support focus navigation, Escape and native Tab', async ({ page }) => {
    await row(page, 0).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: '파일 열기', exact: true })).toBeFocused();
    const owner = (await row(page, 0).boundingBox())!;
    const actions = (await menu(page).boundingBox())!;
    expect(actions.x).toBe(owner.x);
    expect(actions.y).toBeGreaterThanOrEqual(owner.y + owner.height);
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: '수정 기록 보기', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    expect((await messages(page)).at(-1)).toEqual({ type: 'viewHistory', path: '/work/solve0.cpp' });
    await expect(row(page, 0)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(row(page, 0)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('menuitem', { name: '수정 기록 보기', exact: true })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.getByRole('menuitem', { name: '파일 열기', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menu(page)).toBeHidden();
    await expect(row(page, 1)).toBeFocused();
});

test('only the file list scrolls while its heading and primary controls stay fixed', async ({ page }) => {
    const headingBefore = await page.locator('#recent-logs-title').boundingBox();
    const controlsBefore = await page.locator('.bottom-actions').boundingBox();
    await page.locator('#logs-container').hover();
    await page.mouse.wheel(0, 2000);
    await expect.poll(() => page.locator('#logs-container').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.locator('#recent-logs-title').boundingBox()).toEqual(headingBefore);
    expect(await page.locator('.bottom-actions').boundingBox()).toEqual(controlsBefore);
    expect(await page.locator('.logs-section').first().evaluate(el => el.scrollTop)).toBe(0);
    const owner = (await row(page, 29).boundingBox())!;
    const point = { x: owner.x + owner.width - 8, y: owner.y + owner.height - 8 };
    await page.mouse.click(point.x, point.y);
    await expect(menu(page)).toBeVisible();
    const bounds = await menu(page).boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(300);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(650);
    expect(bounds!.y + bounds!.height).toBeLessThan(point.y);
    expect(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.closest('.log-item')?.getAttribute('data-path'), point)).toBe('/work/solve29.cpp');
    await page.screenshot({ path: 'test-results/sidebar-menu-scrolled.png' });
    await page.mouse.dblclick(point.x, point.y);
    await expect(menu(page)).toBeHidden();
    expect((await messages(page)).filter((m: any) => m.type === 'openFile')).toEqual([{ type: 'openFile', path: '/work/solve29.cpp' }]);
    await page.mouse.click(point.x, point.y);
    await expect(menu(page)).toBeVisible();
    await page.locator('#logs-container').evaluate(el => { el.scrollTop = 0; });
    await expect(menu(page)).toBeHidden();
});

test('background updates preserve row identity and close a menu when its file disappears', async ({ page }) => {
    await row(page, 1).click();
    await row(page, 1).evaluate(el => { (window as any).__row = el; });
    await update(page, logs.map(log => ({ ...log, lastModified: log.lastModified + 1000 })));
    expect(await row(page, 1).evaluate(el => el === (window as any).__row)).toBe(true);
    await expect(menu(page)).toBeVisible();
    await page.getByRole('menuitem', { name: '수정 기록 보기', exact: true }).click();
    expect((await messages(page)).at(-1)).toEqual({ type: 'viewHistory', path: '/work/solve1.cpp' });
    await row(page, 1).click();
    await update(page, logs.filter(log => log.filePath !== '/work/solve1.cpp'));
    await expect(menu(page)).toBeHidden();
    await expect(row(page, 1)).toHaveCount(0);
});

test('full history uses the same interactions and view switching dismisses the menu', async ({ page }) => {
    await row(page, 0).click();
    await page.evaluate(allLogs => window.dispatchEvent(new MessageEvent('message', { data: { type: 'showFullLogs', logs: allLogs } })), logs);
    await expect(menu(page)).toBeHidden();
    await row(page, 2, '#full-logs-container').click();
    await expect(menu(page)).toBeVisible();
    await page.getByRole('menuitem', { name: '수정 기록 보기', exact: true }).click();
    expect((await messages(page)).at(-1)).toEqual({ type: 'viewHistory', path: '/work/solve2.cpp' });
    await row(page, 1, '#full-logs-container').dblclick();
    expect((await messages(page)).at(-1)).toEqual({ type: 'openFile', path: '/work/solve1.cpp' });
    await row(page, 0, '#full-logs-container').click();
    await page.locator('#full-logs-back-btn').click();
    await expect(menu(page)).toBeHidden();
    await expect(page.locator('#main-view')).toBeVisible();
});

test('right-click remains available and leaving the webview dismisses its menu', async ({ page }) => {
    await row(page, 0).click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(menu(page)).toBeHidden();
    await row(page, 0).focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: '파일 열기', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(row(page, 0)).toBeFocused();
});
