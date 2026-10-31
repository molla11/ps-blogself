import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';
async function state(page: Page, usage?: unknown) {
    await page.evaluate(usage => window.dispatchEvent(new MessageEvent('message', {data: {
        type: 'updateState', root: '', isRecording: true, languages: ['cpp', 'py'], recentLogs: [], usage,
    }})), usage);
}
test('backend usage fits the compact sidebar, exposes details, and opens the server usage action', async ({page}) => {
    await page.setViewportSize({width: 300, height: 650});
    await openWebview(page, true);
    await state(page, {status: 'ready', label: '최근 1시간 무료 2,469 / 5,000 · 유료 24,000크레딧', detail: '남은 무료 2,530크레딧\n누적 사용 25,000크레딧'});
    const button = page.getByRole('button', {name: '서버 사용량 확인', exact: true});
    await expect(button).toBeInViewport();
    await expect(button).toHaveText('최근 1시간 무료 2,469 / 5,000 · 유료 24,000크레딧');
    await expect(button).toHaveAttribute('title', /누적 사용 25,000크레딧/);
    await button.click();
    expect(await page.evaluate(() => (window as any).__messages.at(-1))).toEqual({type: 'showUsage'});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
