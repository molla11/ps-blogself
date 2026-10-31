import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';

const base = { type: 'model', filePath: '/work/model.c', fileName: 'model.c', editable: true, editToken: 'window-a',
    instructions: '', title: '', markdown: '', count: 1, times: [1], versions: [],
    pending: false, running: false, progress: 100, status: '', error: '', candidate: false,
    plan: { title: '기록', summary: '수정 내용', start: 0, end: 0, steps: [] } };
async function model(page: Page, patch: any = {}) {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { ...base, ...patch });
}
async function choose(page: Page, name: string) {
    await page.locator('#writing-model').click();
    await page.getByRole('option', { name, exact: true }).click();
}

test('four public aliases persist and travel with prepare/write without generation on selection', async ({ page }) => {
    await openWebview(page); await model(page);
    await expect(page.getByRole('button', { name: '모델 high', exact: true })).toBeVisible();
    await page.locator('#writing-model').click();
    expect(await page.getByRole('listbox', { name: '모델', exact: true }).getByRole('option').allTextContents()).toEqual(['standard', 'high', 'Claude Opus 5.5', 'GPT 6 Astra']);
    await expect(page.getByRole('option', { name: 'high', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('option', { name: 'Claude Opus 5.5', exact: true }).click();
    await expect(page.locator('#writing-model-options')).toBeHidden();
    await expect(page.locator('#writing-model')).toBeFocused();
    await expect(page.locator('.model-picker')).not.toContainText(/크레딧|무료|유료|standard-high/);
    expect(await page.evaluate(() => (window as any).__messages.filter((m: any) => ['prepare', 'generate'].includes(m.type)))).toEqual([]);
    await model(page, { pending: true, running: true, writingModel: 'standard-high' });
    await expect(page.locator('#writing-model')).toHaveText('Claude Opus 5.5');
    await expect(page.locator('#writing-model')).toBeDisabled();
    await model(page);
    await page.locator('#prepare-btn').click(); await page.locator('#generate-btn').click();
    const sent = await page.evaluate(() => (window as any).__messages.filter((m: any) => ['prepare', 'generate'].includes(m.type)));
    expect(sent.map((m: any) => m.fields.writingModel)).toEqual(['opus5.5', 'opus5.5']);
    await expect(page.locator('body')).not.toContainText(/terra|gpt-6|claude-opus|추론 강도|\$|USD/i);
    await page.setViewportSize({ width: 340, height: 740 });
    await page.locator('#writing-model').click();
    const bounds = await page.locator('#writing-model').boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(340);
    const menu = await page.getByRole('listbox', { name: '모델', exact: true }).boundingBox();
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(340);
});

test('keyboard navigation, dismissal and selection keep the original request aliases', async ({ page }) => {
    await openWebview(page); await model(page);
    const trigger = page.locator('#writing-model');
    await trigger.focus(); await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { name: 'high', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
    await expect(trigger).toHaveText('high');
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Space'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
    await expect(trigger).toHaveText('GPT 6 Astra');
    await trigger.click(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
    await expect(trigger).toHaveText('standard');
    await trigger.click(); await page.keyboard.press('c'); await page.keyboard.press('Tab');
    await expect(page.getByRole('listbox', { name: '모델', exact: true })).toBeHidden();
    await expect(trigger).toHaveText('standard');
    await expect(trigger).not.toBeFocused();
    await trigger.click(); await page.locator('#plan-title').click();
    await expect(page.getByRole('listbox', { name: '모델', exact: true })).toBeHidden();
    for (const [label, alias] of [['standard', 'standard'], ['high', 'standard-high'], ['Claude Opus 5.5', 'opus5.5'], ['GPT 6 Astra', 'astra']]) {
        await choose(page, label);
        await page.locator('#generate-btn').click();
        expect(await page.evaluate(() => (window as any).__messages.filter((m: any) => m.type === 'generate').at(-1).fields.writingModel)).toBe(alias);
    }
});

test('webview recovery restores the selection and another window cannot edit it', async ({ page }) => {
    await openWebview(page, false, { filePath: base.filePath, editToken: base.editToken, fields: { writingModel: 'astra' } });
    await model(page);
    await expect(page.locator('#writing-model')).toHaveText('GPT 6 Astra');
    await page.locator('#writing-model').click();
    await model(page, { editable: false, editToken: 'window-b', writingModel: 'standard' });
    await expect(page.locator('#writing-model')).toHaveText('standard');
    await expect(page.locator('#writing-model')).toBeDisabled();
    await expect(page.getByRole('listbox', { name: '모델', exact: true })).toBeHidden();
});
