import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';
import { type AccountUsage, usageView } from '../../src/writing/Usage';
test.use({ timezoneId: 'UTC' });
async function state(page: Page, usage?: unknown) {
    await page.evaluate(usage => window.dispatchEvent(new MessageEvent('message', {data: {
        type: 'updateState', root: '', isRecording: true, languages: ['cpp', 'py'], recentLogs: [], usage,
    }})), usage);
}
test('backend usage fits the compact sidebar, exposes details, and opens the server usage action', async ({page}) => {
    await page.clock.install({time: new Date('2026-11-29T11:50:00Z')});
    await page.clock.pauseAt(new Date('2026-11-29T11:50:01Z'));
    await page.setViewportSize({width: 300, height: 650});
    await openWebview(page, true);
    await page.evaluate(() => document.documentElement.style.setProperty('--vscode-descriptionForeground', '#9d9d9d'));
    const account: AccountUsage = {
        unit: 'credits', windowSeconds: 3600, hourlyUsedCredits: 0, freeHourlyUsedCredits: 0, freeHourlyLimitCredits: 3000,
        resetsAt: '2026-11-29T12:17:00Z', freeRemainingCredits: 3000, creditBalance: 119807, canStart: true, nextFunding: 'free', retryAt: null,
        totalUsedCredits: 46761, todayRequests: 0,
    };
    await state(page, usageView(account));
    const button = page.getByRole('button', {name: /무료 크레딧/});
    await expect(button).toBeInViewport();
    await expect(button.locator('#usage-reset')).toHaveCSS('font-size', '11px');
    await expect(button.locator('#usage-reset')).toHaveCSS('color', 'rgb(157, 157, 157)');
    await expect(button.locator('#usage-paid')).toHaveCSS('font-size', '12px');
    expect(await button.innerText()).toBe('남은 무료 크레딧: 3,000 / 3,000\n27분 뒤 / 12:17 PM 초기화\n유료 크레딧: 119,807');
    await expect(button.locator('.codicon-chevron-right')).toHaveJSProperty('hidden', false);
    await expect(button).toHaveAccessibleDescription('사용량 상세 보기');
    await expect(button).toHaveAttribute('title', usageView(account).detail);
    const write = page.getByRole('button', {name: '글 만들기', exact: true});
    for (const width of [300, 220]) {
        await page.setViewportSize({width, height: 650});
        if (width === 220) {
            await state(page, usageView({...account, hourlyUsedCredits: 2999, freeHourlyUsedCredits: 2999, freeRemainingCredits: 1}));
            await expect(button).toContainText('1 / 3,000');
        }
        const balanceBox = (await button.boundingBox())!, writeBox = (await write.boundingBox())!;
        const labelBox = (await button.locator('#usage-label').boundingBox())!;
        const chevron = await button.locator('.codicon-chevron-right').evaluate(el => {
            const { left, right } = el.getBoundingClientRect();
            return { left, right };
        });
        expect(labelBox.x).toBeCloseTo(balanceBox.x, 1);
        expect(chevron.right).toBeCloseTo(balanceBox.x + balanceBox.width, 1);
        expect(chevron.left - (labelBox.x + labelBox.width)).toBeGreaterThanOrEqual(8);
        const email = (await page.locator('#connect-server-btn .account-action-label').boundingBox())!;
        const emailButton = (await page.locator('#connect-server-btn').boundingBox())!;
        const divider = (await page.locator('.account-divider').boundingBox())!;
        expect(labelBox.x).toBeCloseTo(email.x, 1);
        expect(chevron.right).toBeCloseTo(emailButton.x + emailButton.width, 1);
        expect(divider.x).toBeCloseTo(0, 1);
        expect(divider.width).toBeCloseTo(width, 1);
        expect(balanceBox.y + balanceBox.height).toBeLessThanOrEqual(writeBox.y);
        const lines = button.locator('#usage-label > span:visible');
        await expect(lines).toHaveCount(3);
        for (const line of await lines.all()) {
            const rects = await line.evaluate(el => {
                const range = document.createRange();
                range.selectNodeContents(el);
                return range.getClientRects().length;
            });
            expect(rects).toBe(1);
        }
        await expect(write).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.clock.fastForward('01:00');
    await expect(button.locator('#usage-reset')).toHaveText('26분 뒤 / 12:17 PM 초기화');
    await page.clock.fastForward('26:00');
    await expect(button.locator('#usage-reset')).toHaveText('사용량 갱신 중…');
    await expect(button).toContainText('1 / 3,000');
    await state(page, usageView(account));
    expect(await page.evaluate(() => (window as any).__messages.filter((m: any) => m.type === 'refreshUsage'))).toHaveLength(1);
    await state(page, usageView({...account, resetsAt: '2026-11-29T13:17:00Z'}));
    await expect(button.locator('#usage-reset')).toHaveText('60분 뒤 / 1:17 PM 초기화');
    await expect(button).toContainText('3,000 / 3,000');
    await button.press('Enter');
    expect(await page.evaluate(() => (window as any).__messages.at(-1))).toEqual({type: 'showUsage'});
});
test('missing usage stays hidden; loading and failures do not show a made-up allowance', async ({page}) => {
    await openWebview(page, true); await state(page);
    const button = page.locator('#usage-btn');
    await expect(button).toBeHidden();
    await state(page, {status: 'loading', label: '사용량 불러오는 중…'}); await expect(button).toBeDisabled();
    await state(page, {status: 'error', label: '사용량 확인 불가 · 다시 확인', detail: '연결 실패'});
    await expect(button).toBeEnabled(); await expect(button).not.toContainText('$0');
    await button.click();
    expect(await page.evaluate(() => (window as any).__messages.at(-1))).toEqual({type: 'showUsage'});
    await state(page); await expect(button).toBeHidden();
});
