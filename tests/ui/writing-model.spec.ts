import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';

const base = { type: 'model', filePath: '/work/model.c', fileName: 'model.c', editable: true, editToken: 'window-a',
    instructions: '', title: '', markdown: '', count: 1, times: [1], versions: [],
    pending: false, running: false, progress: 100, status: '', error: '', candidate: false,
    plan: { title: '기록', summary: '수정 내용', start: 0, end: 0, steps: [] } };
async function model(page: Page, patch: any = {}) {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { ...base, ...patch });
}
async function access(page: Page, paidAvailable: boolean) {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { type: 'modelAccess',
        models: ['standard', 'standard-high', 'opus5.5', 'astra'].map(id => ({ id, paidOnly: ['opus5.5', 'astra'].includes(id),
            available: ['standard', 'standard-high'].includes(id) || paidAvailable,
            nextFunding: ['standard', 'standard-high'].includes(id) ? 'free' : paidAvailable ? 'credit' : null })) });
}

test('four public aliases persist and travel with prepare/write without generation on selection', async ({ page }) => {
    await openWebview(page); await model(page);
    await expect(page.getByLabel('모델', { exact: true })).toHaveValue('standard-high');
    expect(await page.locator('#writing-model option').allTextContents()).toEqual(['standard', 'standard-high', 'opus5.5', 'astra']);
    await page.locator('#writing-model').selectOption('opus5.5');
    await expect(page.locator('#writing-model-help')).toContainText('유료 크레딧 전용');
    expect(await page.evaluate(() => (window as any).__messages.filter((m: any) => ['prepare', 'generate'].includes(m.type)))).toEqual([]);
    await model(page, { pending: true, running: true, writingModel: 'standard-high' });
    await expect(page.locator('#writing-model')).toHaveValue('opus5.5');
    await expect(page.locator('#writing-model')).toBeDisabled();
    await model(page);
    await page.locator('#prepare-btn').click(); await page.locator('#generate-btn').click();
    const sent = await page.evaluate(() => (window as any).__messages.filter((m: any) => ['prepare', 'generate'].includes(m.type)));
    expect(sent.map((m: any) => m.fields.writingModel)).toEqual(['opus5.5', 'opus5.5']);
    await expect(page.locator('body')).not.toContainText(/terra|gpt-6|claude-opus|추론 강도|\$|USD/i);
    await page.setViewportSize({ width: 340, height: 740 });
    const bounds = await page.locator('#writing-model').boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(340);
});

test('paid balance availability updates without switching models, and standard remains usable', async ({ page }) => {
    await openWebview(page); await model(page); await access(page, false);
    await page.locator('#writing-model').selectOption('astra');
    await expect(page.locator('#generate-btn')).toBeDisabled();
    await expect(page.locator('#prepare-btn')).toBeDisabled();
    await expect(page.locator('#writing-model-help')).toContainText('유료 크레딧이 필요');
    await page.locator('#model-usage-btn').click();
    await access(page, true);
    await expect(page.locator('#writing-model')).toHaveValue('astra');
    await expect(page.locator('#generate-btn')).toBeEnabled();
    await access(page, false);
    await page.locator('#writing-model').selectOption('standard');
    await expect(page.locator('#generate-btn')).toBeEnabled();
    await expect(page.locator('#writing-model-help')).toContainText('무료 크레딧');
});

test('webview recovery restores the selection and another window cannot edit it', async ({ page }) => {
    await openWebview(page, false, { filePath: base.filePath, editToken: base.editToken, fields: { writingModel: 'astra' } });
    await model(page);
    await expect(page.locator('#writing-model')).toHaveValue('astra');
    await model(page, { editable: false, editToken: 'window-b', writingModel: 'standard' });
    await expect(page.locator('#writing-model')).toHaveValue('standard');
    await expect(page.locator('#writing-model')).toBeDisabled();
});
