import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';

const logs = Array.from({ length: 6 }, (_, i) => ({
    fileName: `solve${i}.cpp`, filePath: `/work/solve${i}.cpp`, language: 'cpp', lastModified: Date.now() - i * 1000,
}));
async function state(page: Page, root = '', currentDirectory = '/work') {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), {
        type: 'updateState', root, currentDirectory, isRecording: true, languages: ['cpp'], recentLogs: logs,
    });
}
async function lastMessage(page: Page) { return page.evaluate(() => (window as any).__messages.at(-1)); }
const trigger = (page: Page) => page.getByRole('button', { name: '활성 경로 선택', exact: true });
const menu = (page: Page) => page.getByRole('menu', { name: '활성 경로', exact: true });

test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 650 });
    await openWebview(page, true);
    await state(page);
});

test('the path field offers exactly the folder picker and the displayed current directory', async ({ page }) => {
    await expect(page.locator('.path-settings')).toHaveCount(0);
    await expect(page.locator('#root-folder-display')).toHaveText('현재 열려있는 모든 파일');
    await expect(page.locator('#root-folder-hint')).toBeHidden();
    await trigger(page).click();
    await expect(menu(page).getByRole('menuitem')).toHaveCount(2);
    await menu(page).getByRole('menuitem', { name: '디렉토리 직접 선택', exact: true }).click();
    expect(await lastMessage(page)).toEqual({ type: 'selectRootFolder' });
    await expect(menu(page)).toBeHidden();
    await trigger(page).click();
    await menu(page).getByRole('menuitem', { name: '/work/로 설정', exact: true }).click();
    expect(await lastMessage(page)).toEqual({ type: 'useWorkspaceRoot', path: '/work' });
    await state(page, '/work');
    await expect(page.locator('#root-folder-display')).toHaveText('/work');
    await expect(page.locator('#root-folder-hint')).toBeVisible();
});

test('reset lives inside the field with its tooltip above and clears the active path', async ({ page }) => {
    await state(page, '/work');
    const reset = page.getByRole('button', { name: '활성 경로 재설정', exact: true });
    const control = (await page.locator('.path-control').boundingBox())!;
    const bounds = (await reset.boundingBox())!;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(control.x + control.width);
    expect(bounds.x).toBeGreaterThan(control.x + control.width / 2);
    await reset.hover();
    const tooltip = page.getByRole('tooltip', { name: '활성 경로 재설정', exact: true });
    await expect(tooltip).toBeVisible();
    const tip = (await tooltip.boundingBox())!;
    expect(tip.y + tip.height).toBeLessThan(bounds.y);
    await reset.click();
    expect(await lastMessage(page)).toEqual({ type: 'clearRootFolder' });
    await state(page);
    await expect(page.locator('#root-folder-display')).toHaveText('현재 열려있는 모든 파일');
});

test('long paths truncate from the left while retaining their full value and action suffix', async ({ page }) => {
    for (const directory of ['/home/developer/a-very-long-project-directory/solutions/asdf', 'C:\\Users\\Developer\\a-very-long-project-directory\\solutions\\asdf']) {
        await state(page, directory, directory);
        await trigger(page).click();
        const item = page.locator('#use-ws-root-btn');
        const truncation = await item.locator('.path-ellipsis').evaluate(el => ({
            direction: getComputedStyle(el).direction, overflow: getComputedStyle(el).textOverflow,
            clipped: el.scrollWidth > el.clientWidth,
        }));
        expect(truncation).toEqual({ direction: 'rtl', overflow: 'ellipsis', clipped: true });
        await expect(item.locator('.path-suffix')).toBeVisible();
        const separator = directory.includes('\\') ? '\\' : '/';
        await expect(page.locator('#current-directory-label')).toHaveText(directory + separator);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await item.click();
        expect(await lastMessage(page)).toEqual({ type: 'useWorkspaceRoot', path: directory });
    }
});

test('path actions support keyboard navigation, outside dismissal and a missing current directory', async ({ page }) => {
    await trigger(page).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#select-folder-btn')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#use-ws-root-btn')).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await lastMessage(page)).toEqual({ type: 'useWorkspaceRoot', path: '/work' });
    await expect(trigger(page)).toBeFocused();
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await state(page, '', '');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('#use-ws-root-btn')).toBeDisabled();
    await expect(page.locator('#select-folder-btn')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menu(page)).toBeHidden();
    await expect(page.locator('#clear-folder-btn')).toBeFocused();
    await trigger(page).click();
    await page.locator('.config-title').first().click();
    await expect(menu(page)).toBeHidden();
});

test('path and file menus dismiss each other and current-directory updates use the displayed path', async ({ page }) => {
    const file = page.locator('.log-item').nth(3);
    await file.click();
    await expect(page.locator('#context-menu')).toBeVisible();
    await trigger(page).click();
    await expect(page.locator('#context-menu')).toBeHidden();
    await expect(menu(page)).toBeVisible();
    await file.click();
    await expect(menu(page)).toBeHidden();
    await expect(page.locator('#context-menu')).toBeVisible();
    await trigger(page).click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'currentDirectory', path: '/other/workspace' } })));
    await page.getByRole('menuitem', { name: '/other/workspace/로 설정', exact: true }).click();
    expect(await lastMessage(page)).toEqual({ type: 'useWorkspaceRoot', path: '/other/workspace' });
});
