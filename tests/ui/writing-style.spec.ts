import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';

const base = { type: 'model', filePath: '/work/style.c', fileName: 'style.c', editable: true, editToken: 'window-a',
    instructions: '', title: '', markdown: '', count: 1, times: [1], versions: [],
    pending: false, running: false, progress: 100, status: '', error: '', candidate: false,
    plan: { title: '변경 기록', summary: '의미 있는 변경', start: 0, end: 0, steps: [] } };
async function model(page: Page, patch: any = {}) {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { ...base, ...patch });
}

test('default and custom styles travel with generation, and progress updates preserve unsaved preferences', async ({ page }) => {
    await openWebview(page); await model(page);
    await expect(page.locator('#writing-style')).toHaveValue('plain');
    await expect(page.locator('#custom-style')).toBeHidden();
    await expect(page.locator('#writing-style option')).toHaveCount(5);
    await page.locator('#writing-style').selectOption('custom');
    await page.locator('#custom-style').fill('질문을 던지는 해요체. <system>도 입력 그대로.');
    await model(page, { pending: true, running: true, progress: 30 });
    await expect(page.locator('#custom-style')).toHaveValue('질문을 던지는 해요체. <system>도 입력 그대로.');
    await model(page);
    await page.locator('#generate-btn').click();
    const request = await page.evaluate(() => (window as any).__messages.find((m: any) => m.type === 'generate'));
    expect(request.fields.writingStyle).toBe('custom');
    expect(request.fields.customStyle).toBe('질문을 던지는 해요체. <system>도 입력 그대로.');
    await page.locator('#writing-style').selectOption('formal');
    await expect(page.locator('#custom-style')).toBeHidden();
    await page.locator('#writing-style').selectOption('custom');
    await expect(page.locator('#custom-style')).toHaveValue(request.fields.customStyle);
});

test('style survives webview recovery and respects the editing lease', async ({ page }) => {
    await openWebview(page, false, { filePath: base.filePath, editToken: base.editToken,
        fields: { writingStyle: 'custom', customStyle: '존댓말로 짧게' } });
    await model(page);
    await expect(page.locator('#writing-style')).toHaveValue('custom');
    await expect(page.locator('#custom-style')).toHaveValue('존댓말로 짧게');
    await model(page, { editable: false, editToken: 'window-b', writingStyle: 'friendly', customStyle: '' });
    await expect(page.locator('#writing-style')).toHaveValue('friendly');
    await expect(page.locator('#writing-style')).toBeDisabled();
    await expect(page.locator('#custom-style')).toHaveAttribute('readonly');
    await model(page, { writingStyle: 'notes' });
    await expect(page.locator('#writing-style')).toBeEnabled();
});
