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

test('writing streams and can be cancelled without a duplicate webview progress notice', async ({ page }) => {
    await openWebview(page);
    await update(page);
    await expect(page.locator('#generation-loading')).toHaveCount(0);
    await expect(page.locator('#progress-box')).toBeHidden();
    await expect(page.locator('#article-view')).toBeVisible();
    await expect(page.locator('#article-title')).toHaveJSProperty('readOnly', true);
    await expect(page.locator('.prose-editor')).toHaveAttribute('contenteditable', 'false');
    await update(page, { progress: 60, streamMarkdown: '먼저 도착한 본문' });
    await expect(page.locator('.prose-editor')).toContainText('먼저 도착한 본문');
    await expect(page.locator('#progress-box')).toBeHidden();
    await page.getByRole('button', { name: '글 작성 취소' }).click();
    expect(await page.evaluate(() => (window as any).__messages.at(-1).type)).toBe('cancel');
    await update(page, { pending: false, running: false, status: '작업을 취소했습니다.' });
    await expect(page.locator('#plan-view')).toBeVisible();
    await expect(page.locator('.prose-editor')).not.toContainText('먼저 도착한 본문');
});

test('preparation and retry leave the webview notice hidden while a failed memo exposes its actions', async ({ page }) => {
    await openWebview(page);
    const preparing = { plan: undefined, pendingKind: 'prepare_blog', pendingId: 'prepare-1' };
    await update(page, preparing);
    await expect(page.locator('#progress-box')).toBeHidden();
    await expect(page.locator('#generation-loading')).toHaveCount(0);
    await expect(page.locator('.skeleton')).toHaveCount(0);
    await update(page, { ...preparing, running: false, error: '연결에 실패했습니다.' });
    await expect(page.locator('#progress-box')).toBeVisible();
    await expect(page.locator('#status-text')).toHaveText('메모 생성 보류');
    await update(page, preparing);
    await expect(page.locator('#progress-box')).toBeHidden();
    await update(page, { pending: false, running: false });
    await expect(page.locator('#progress-box')).toBeHidden();
    await expect(page.locator('#plan-content')).toBeVisible();
});

test('a narrow editor keeps summaries editable during generation', async ({ page }) => {
    await page.setViewportSize({ width: 340, height: 650 });
    await openWebview(page);
    await update(page);
    await page.locator('#plan-tab').click();
    await page.locator('#summary').fill('생성 중에 고친 설명');
    await update(page, { progress: 80 });
    await expect(page.locator('#summary')).toHaveValue('생성 중에 고친 설명');
    await expect(page.locator('#plan-view')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('native retry applies to the current failed draft and keeps unsaved edits', async ({ page }) => {
    await openWebview(page);
    const failure = { running: false, error: '입력 보안 검사를 완료하지 못했습니다.', errorId: 'error-a' };
    await update(page, failure);
    await expect(page.getByText(failure.error)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '크레딧 충전' })).toHaveCount(0);
    await page.locator('#summary').fill('유지할 풀이 설명');
    const retry = async (patch: Record<string, unknown> = {}) => {
        await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), {
            type: 'retryWriting', action: 'retry', errorId: 'error-a', editToken: 'window-a', pendingId: 'write-1', ...patch,
        });
    };
    const retries = () => page.evaluate(() => (window as any).__messages.filter((m: any) => m.type === 'retry'));
    await retry({ errorId: 'old-error' });
    await retry({ editToken: 'other-window' });
    await retry({ pendingId: 'old-job' });
    expect(await retries()).toHaveLength(0);
    await retry();
    expect(await retries()).toMatchObject([{ errorId: 'error-a', fields: { plan: { summary: '유지할 풀이 설명' } } }]);
    await page.locator('#cancel-btn').click();
    expect(await page.evaluate(() => (window as any).__messages.at(-1).type)).toBe('discardPending');
    await update(page, { ...failure, editable: false });
    await retry();
    await expect(page.locator('#generate-btn')).toBeDisabled();
    await update(page, { ...failure, backendEnabled: false });
    await retry();
    expect(await retries()).toHaveLength(1);
});
