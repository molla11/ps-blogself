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
    if (name.endsWith('(유료)')) await answerCheck(page);
}
async function latestCheck(page: Page) {
    return page.evaluate(() => (window as any).__messages.filter((m: any) => m.type === 'checkWritingModel').at(-1));
}
async function answerCheck(page: Page, allowed = true, request?: any) {
    request ||= await latestCheck(page);
    expect(request).toBeTruthy();
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), {
        ...request, type: 'writingModelChecked', allowed,
        ...(allowed ? {} : { message: '유료 크레딧이 없어 이전 모델을 유지했습니다.' }),
    });
}

test('four public aliases persist and travel with prepare/write without generation on selection', async ({ page }) => {
    await openWebview(page); await model(page);
    await expect(page.getByRole('button', { name: '모델 high', exact: true })).toBeVisible();
    await expect(page.locator('#writing-model-help')).toBeHidden();
    await page.locator('#writing-model').click();
    expect(await page.getByRole('listbox', { name: '모델', exact: true }).getByRole('option').allTextContents()).toEqual(['standard', 'high', 'Claude Opus 5.5 (유료)', 'GPT 6 Astra (유료)']);
    await expect(page.getByRole('option', { name: 'high', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('option', { name: 'Claude Opus 5.5 (유료)', exact: true }).click();
    await expect(page.locator('#writing-model')).toHaveText('high');
    await answerCheck(page);
    await expect(page.locator('#writing-model-options')).toBeHidden();
    await expect(page.locator('#writing-model')).toBeFocused();
    await expect(page.locator('#writing-model-help')).toBeVisible();
    await expect(page.locator('#writing-model-help')).toHaveText('유료 모델은 유료 크레딧만으로 작동합니다.');
    await expect(page.locator('#writing-model')).toHaveAccessibleDescription('유료 모델은 유료 크레딧만으로 작동합니다.');
    await expect(page.locator('#writing-model-hint')).toBeEmpty();
    expect(await page.evaluate(() => (window as any).__messages.filter((m: any) => ['prepare', 'generate'].includes(m.type)))).toEqual([]);
    await model(page, { pending: true, running: true, writingModel: 'standard-high' });
    await expect(page.locator('#writing-model')).toHaveText('Claude Opus 5.5 (유료)');
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
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/writing-paid-model-narrow.png', fullPage: true });
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
    await answerCheck(page);
    await expect(trigger).toHaveText('GPT 6 Astra (유료)');
    await trigger.click(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
    await expect(trigger).toHaveText('standard');
    await expect(page.locator('#writing-model-hint')).toBeEmpty();
    await trigger.click(); await page.keyboard.press('c'); await page.keyboard.press('Tab');
    await expect(page.getByRole('listbox', { name: '모델', exact: true })).toBeHidden();
    await expect(trigger).toHaveText('standard');
    await expect(trigger).not.toBeFocused();
    await trigger.click(); await page.locator('#plan-title').click();
    await expect(page.getByRole('listbox', { name: '모델', exact: true })).toBeHidden();
    for (const [label, alias] of [['standard', 'standard'], ['high', 'standard-high'], ['Claude Opus 5.5 (유료)', 'opus5.5'], ['GPT 6 Astra (유료)', 'astra']]) {
        await choose(page, label);
        if (label.includes('(유료)')) await expect(page.locator('#writing-model-help')).toBeVisible();
        else {
            await expect(page.locator('#writing-model-help')).toBeHidden();
            await expect(trigger).not.toHaveAttribute('aria-describedby');
        }
        await page.locator('#generate-btn').click();
        expect(await page.evaluate(() => (window as any).__messages.filter((m: any) => m.type === 'generate').at(-1).fields.writingModel)).toBe(alias);
    }
});

test('webview recovery restores the selection and another window cannot edit it', async ({ page }) => {
    await openWebview(page, false, { filePath: base.filePath, editToken: base.editToken, fields: { writingModel: 'astra' } });
    await model(page);
    await expect(page.locator('#writing-model')).toHaveText('GPT 6 Astra (유료)');
    await expect(page.locator('#writing-model-help')).toBeVisible();
    await page.locator('#writing-model').click();
    await model(page, { editable: false, editToken: 'window-b', writingModel: 'standard' });
    await expect(page.locator('#writing-model')).toHaveText('standard');
    await expect(page.locator('#writing-model-help')).toBeHidden();
    await expect(page.locator('#writing-model')).toBeDisabled();
    await expect(page.getByRole('listbox', { name: '모델', exact: true })).toBeHidden();
});

test('an unavailable paid model preserves the previous choice and never saves the rejected model', async ({ page }) => {
    await openWebview(page); await model(page, { writingModel: 'standard' });
    for (const label of ['Claude Opus 5.5 (유료)', 'GPT 6 Astra (유료)']) {
        await page.locator('#writing-model').click();
        await page.getByRole('option', { name: label, exact: true }).click();
        await expect(page.locator('#writing-model')).toHaveText('standard');
        await answerCheck(page, false);
        await expect(page.locator('#writing-model')).toHaveText('standard');
        await expect(page.locator('#writing-model-hint')).toHaveText('유료 크레딧이 없어 이전 모델을 유지했습니다.');
    }
    await page.locator('#generate-btn').click();
    const requests = await page.evaluate(() => (window as any).__messages);
    expect(requests.filter((m: any) => ['save', 'prepare'].includes(m.type))).toEqual([]);
    expect(requests.find((m: any) => m.type === 'generate').fields.writingModel).toBe('standard');
});

test('late balance checks cannot overwrite a newer choice, an active request or another window', async ({ page }) => {
    await openWebview(page); await model(page);
    const pending = async () => {
        await page.locator('#writing-model').click();
        await page.getByRole('option', { name: 'GPT 6 Astra (유료)', exact: true }).click();
        return latestCheck(page);
    };
    const old = await pending();
    await choose(page, 'standard');
    await answerCheck(page, true, old);
    await expect(page.locator('#writing-model')).toHaveText('standard');
    const generating = await pending();
    await page.locator('#generate-btn').click();
    await answerCheck(page, true, generating);
    await expect(page.locator('#writing-model')).toHaveText('standard');
    const moved = await pending();
    await model(page, { editable: false, editToken: 'window-b', writingModel: 'standard-high' });
    await answerCheck(page, true, moved);
    await expect(page.locator('#writing-model')).toHaveText('high');
    await expect(page.locator('#writing-model')).toBeDisabled();
});
