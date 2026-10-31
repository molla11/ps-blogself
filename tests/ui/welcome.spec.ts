import { test, expect } from '@playwright/test';
import { openWebview } from './webview';

test('welcome opens only the chosen action and stays idle until a click', async ({ page }) => {
    await openWebview(page, 'welcome');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('PS-Blogself');
    expect(await page.evaluate(() => (window as any).__messages)).toEqual([]);
    for (const action of ['connect', 'sample', 'history', 'settings']) {
        await page.locator(`[data-action="${action}"]`).click();
        expect(await page.evaluate(() => (window as any).__messages.at(-1))).toEqual({ type: 'action', action });
        await expect(page.locator('[data-action]:disabled')).toHaveCount(4);
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'actionResult' } })));
        await expect(page.locator('[data-action]:disabled')).toHaveCount(0);
    }
});

test('keyboard actions prevent duplicate requests and recover after an error', async ({ page }) => {
    await openWebview(page, 'welcome');
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-action="connect"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await page.locator('[data-action="connect"]').dispatchEvent('click');
    expect(await page.evaluate(() => (window as any).__messages.length)).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'actionResult', error: '연결을 확인하고 다시 시도해 주세요.' } })));
    await expect(page.getByRole('alert')).toHaveText('연결을 확인하고 다시 시도해 주세요.');
    await page.locator('[data-action="connect"]').click();
    await expect(page.getByRole('alert')).toBeHidden();
    expect(await page.evaluate(() => (window as any).__messages.length)).toBe(2);
});

for (const [theme, width] of [['dark', 1000], ['light', 1000], ['dark', 360]] as const) {
    test(`welcome remains readable in ${theme} at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 760 });
        await openWebview(page, 'welcome');
        if (theme === 'light') await page.evaluate(() => {
            const style = document.createElement('style'); style.nonce = 'test-nonce';
            style.textContent = ':root { --vscode-editor-background: #ffffff; --vscode-foreground: #333333; --vscode-descriptionForeground: #616161; --vscode-widget-border: #d4d4d4; --vscode-textLink-foreground: #006ab1; }';
            document.head.append(style);
        });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        for (const button of await page.getByRole('button').all()) await expect(button).toBeVisible();
        await page.screenshot({ path: `test-results/welcome-${theme}-${width}.png`, fullPage: true });
    });
}
