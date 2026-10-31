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

test('model errors offer retry, credits and dismissal without losing the draft', async ({ page }) => {
    await page.setViewportSize({ width: 340, height: 650 });
    await openWebview(page);
    await update(page, { running: false, error: '선택한 모델은 유료 크레딧으로만 사용할 수 있습니다.' });
    const actions = page.locator('#error-box .actions');
    expect(await actions.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label') || button.textContent?.trim()))).toEqual(['다시 시도', '크레딧 충전', '오류 닫기']);
    for (const button of await actions.getByRole('button').all()) await expect(button).toBeVisible();
    await expect(page.getByRole('button', { name: '오류 닫기', exact: true })).toBeVisible();
    await expect(page.locator('#error-box')).not.toContainText('새 요청 준비');
    await expect(page.locator('#writing-model')).toBeDisabled();
    await page.locator('#summary').fill('유지할 풀이 설명');
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    expect(await page.evaluate(() => (window as any).__messages.at(-1))).toMatchObject({ type: 'retry', fields: { plan: { summary: '유지할 풀이 설명' } } });
    await page.getByRole('button', { name: '크레딧 충전', exact: true }).click();
    expect(await page.evaluate(() => (window as any).__messages.at(-1).type)).toBe('rechargeCredits');
    await page.getByRole('button', { name: '오류 닫기', exact: true }).click();
    expect(await page.evaluate(() => (window as any).__messages.at(-1).type)).toBe('discardPending');
    await update(page, { pending: false, running: false });
    await expect(page.locator('#error-box')).toBeHidden();
    await expect(page.locator('#writing-model')).toBeEnabled();
    await expect(page.locator('#summary')).toHaveValue('유지할 풀이 설명');
    expect(await page.evaluate(() => (window as any).__messages.filter((m: any) => ['prepare', 'generate'].includes(m.type)))).toHaveLength(0);
    await update(page, { pending: false, running: false, error: '요청을 시작할 수 없습니다.' });
    await expect(page.getByRole('button', { name: '오류 닫기', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/writing-error-actions.png', fullPage: true });
    await update(page, { running: false, editable: false, error: '모델 응답을 처리하지 못했습니다.' });
    await expect(page.locator('#retry-btn')).toBeDisabled();
    await expect(page.locator('#discard-pending-btn')).toBeDisabled();
    await expect(page.locator('#recharge-credits-btn')).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
