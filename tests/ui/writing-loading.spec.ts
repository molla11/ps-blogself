import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';

const plan = { title: '풀이', summary: '풀이 설명', start: 0, end: 0, steps: [] };
const base = {
    type: 'model', filePath: '/work/solve.cpp', fileName: 'solve.cpp',
    editable: true, editToken: 'window-a', plan, instructions: '', title: '', markdown: '',
    count: 1, times: [1], revision: 1, pending: true, running: true,
    pendingId: 'write-1', pendingKind: 'write_blog', progress: 10,
    status: '', error: '', candidate: false, versions: [],
};
async function update(page: Page, patch: Record<string, unknown> = {}) {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { ...base, ...patch });
}

test('writing stays in the bottom corner without time labels while streaming and cancellation still work', async ({ page }) => {
    await openWebview(page);
    await update(page);
    const loading = page.locator('#generation-loading');
    await expect(loading).toBeVisible();
    await expect(page.locator('#loading-estimate, #loading-elapsed, [role=timer]')).toHaveCount(0);
    await expect(loading).toHaveText('작성 중…');
    const bounds = (await loading.boundingBox())!;
    expect(bounds.x + bounds.width).toBeGreaterThan(page.viewportSize()!.width - 24);
    expect(bounds.y + bounds.height).toBeGreaterThan(page.viewportSize()!.height - 24);
    expect(bounds.width).toBeLessThan(140);
    expect(bounds.height).toBeLessThan(40);
    await update(page, { progress: 60, streamHtml: '<p>먼저 도착한 본문</p>' });
    await expect(loading).toHaveText('작성 중…');
    await expect(page.locator('#stream-preview')).toContainText('먼저 도착한 본문');
    await page.locator('#cancel-btn').click();
    expect(await page.evaluate(() => (window as any).__messages.at(-1).type)).toBe('cancel');
    await update(page, { pending: false, running: false, status: '작업을 취소했습니다.' });
    await expect(loading).toBeHidden();
});

test('preparation, errors, retry and completion update the small status indicator', async ({ page }) => {
    await openWebview(page);
    const preparing = { plan: undefined, pendingKind: 'prepare_blog', pendingId: 'prepare-1' };
    await update(page, preparing);
    await expect(page.locator('#generation-loading')).toBeVisible();
    await expect(page.locator('#loading-title')).toHaveText('준비 중…');
    await expect(page.locator('.skeleton')).toHaveCount(0);
    await update(page, { ...preparing, running: false, error: '연결에 실패했습니다.' });
    await expect(page.locator('#generation-loading')).toBeHidden();
    await expect(page.locator('#error-box')).toBeVisible();
    await update(page, preparing);
    await expect(page.locator('#generation-loading')).toBeVisible();
    await update(page, { pending: false, running: false });
    await expect(page.locator('#generation-loading')).toBeHidden();
    await expect(page.locator('#plan-content')).toBeVisible();
});

test('loading fits a narrow editor, respects reduced motion and keeps explanations editable', async ({ page }) => {
    await page.setViewportSize({ width: 340, height: 650 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openWebview(page);
    await update(page);
    await expect(page.locator('.loading-spinner')).toHaveCSS('animation-name', 'none');
    await page.locator('#summary').fill('생성 중에 고친 설명');
    await update(page, { progress: 80 });
    await expect(page.locator('#summary')).toHaveValue('생성 중에 고친 설명');
    await expect(page.locator('#generation-loading')).toHaveCSS('pointer-events', 'none');
    const bounds = (await page.locator('#generation-loading').boundingBox())!;
    expect(bounds.x).toBeGreaterThan(0);
    expect(bounds.x + bounds.width).toBeLessThan(340);
    await expect(page.locator('#generation-loading')).toHaveAttribute('role', 'status');
});
