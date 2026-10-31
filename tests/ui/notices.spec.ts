import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';

const globalNotice = { id: '11111111-1111-4111-8111-111111111111', title: '새로운 글 구성 모드', body: '수정 과정과 알고리즘 설명 중 원하는 구성을 선택해 보세요.', audience: 'all' };
const personalNotice = { id: '22222222-2222-4222-8222-222222222222', title: '계정 안내', body: '요청하신 내용을 확인했어요.\n<img src=x onerror=alert(1)>', audience: 'user' };
async function update(page: Page, notices: unknown[]) {
    await page.evaluate(notices => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'updateState', root: '/work', isRecording: true, languages: ['cpp'], notices,
        recentLogs: [{ fileName: 'solve.cpp', filePath: '/work/solve.cpp', language: 'cpp', lastModified: Date.now() }], totalLogSize: '10 KB',
    } })), notices);
}
test('notices appear above the controls, preserve expansion and close only after acknowledgement', async ({ page }, info) => {
    await page.setViewportSize({ width: 340, height: 800 });
    await openWebview(page, true); await update(page, [globalNotice, personalNotice]);
    const region = page.getByRole('region', { name: '서비스 공지' });
    await expect(region).toBeVisible();
    const banner = (await region.boundingBox())!, controls = (await page.locator('#main-view').boundingBox())!;
    expect(banner.y + banner.height).toBeLessThanOrEqual(controls.y);
    await page.locator('summary').filter({ hasText: '계정 안내' }).click();
    await expect(region.locator('p').filter({ hasText: '<img' })).toBeVisible();
    await expect(region.locator('img')).toHaveCount(0);
    await update(page, [globalNotice, personalNotice]);
    await expect(region.locator('details[open]')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('sidebar-notices.png') });
    await page.getByRole('button', { name: '계정 안내 공지 닫기' }).click();
    expect(await page.evaluate(() => (window as any).__messages.at(-1))).toEqual({ type: 'dismissNotice', id: personalNotice.id });
    await expect(region.locator('details')).toHaveCount(2);
    await update(page, [globalNotice]);
    await expect(region.locator('details[open]')).toHaveCount(1);
    await update(page, []); await expect(region).toBeHidden();
});
test('long notices scroll within their own area and leave the sidebar usable', async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 650 });
    await openWebview(page, true); await update(page, [{ ...globalNotice, body: '공지 내용 '.repeat(300) }]);
    const region = page.locator('#service-notices');
    expect((await region.boundingBox())!.height).toBeLessThanOrEqual(650 * 0.35 + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#generate-blog-btn')).toBeVisible();
    await region.hover(); await page.mouse.wheel(0, 1000);
    await expect.poll(() => region.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
});
