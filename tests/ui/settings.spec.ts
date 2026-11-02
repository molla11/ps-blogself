import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';
const initial = { type: 'settings', root: '/work', currentDirectory: '/work', recording: true, extensions: ['c', 'cpp', 'py'], prepareOnReview: true };
const emit = (page: Page, value: any) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), value);
const messages = (page: Page) => page.evaluate(() => (window as any).__messages);

test('settings exposes recording controls without model or service configuration', async ({ page }) => {
    await openWebview(page, 'settings'); await emit(page, initial);
    await expect(page.locator('#root')).toHaveValue('/work'); await expect(page.locator('#extensions')).toHaveValue('.c, .cpp, .py');
    await expect(page.locator('body')).not.toContainText(/모델|백엔드|API|제공자/);
    await page.locator('#recording').uncheck();
    expect((await messages(page)).at(-1)).toMatchObject({ type: 'save', field: 'recording', value: false });
    await page.locator('#prepare-on-review').uncheck();
    expect((await messages(page)).at(-1)).toMatchObject({ type: 'save', field: 'prepareOnReview', value: false });
    await page.setViewportSize({ width: 360, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/settings-narrow.png', fullPage: true });
});

test('workspace updates and older acknowledgements preserve newer text input', async ({ page }) => {
    await openWebview(page, 'settings'); await emit(page, initial);
    await page.locator('#extensions').fill('.CPP, py, .js'); await page.locator('#save-extensions').click();
    const saved = (await messages(page)).at(-1); expect(saved.value).toEqual(['.CPP', 'py', '.js']);
    await page.locator('#extensions').fill('.cpp, .py, .js, .rs');
    await emit(page, { ...initial, extensions: ['cpp', 'py', 'js'], root: '/other-window' });
    await emit(page, { type: 'saved', id: saved.id, field: 'extensions' });
    await expect(page.locator('#extensions')).toHaveValue('.cpp, .py, .js, .rs');
    await expect(page.locator('#root')).toHaveValue('/other-window');
    await page.locator('#save-extensions').click(); const latest = (await messages(page)).at(-1);
    await emit(page, { ...initial, extensions: ['cpp', 'py', 'js', 'rs'] }); await emit(page, { type: 'saved', id: latest.id, field: 'extensions' });
    await expect(page.locator('#status')).toHaveText('저장됨');
});

test('folder selection cancellation preserves input and failures remain editable', async ({ page }) => {
    await openWebview(page, 'settings'); await emit(page, initial);
    await page.locator('#root').fill('/typing'); await page.locator('#choose-folder').click();
    const choose = (await messages(page)).at(-1);
    await emit(page, initial); await emit(page, { type: 'saved', id: choose.id, applied: false });
    await expect(page.locator('#root')).toHaveValue('/typing');
    await page.locator('#save-root').click(); const save = (await messages(page)).at(-1);
    await emit(page, { type: 'error', id: save.id, message: '존재하는 폴더를 선택해 주세요.' });
    await expect(page.locator('#root')).toHaveValue('/typing'); await expect(page.locator('#error')).toBeVisible();
    await page.locator('#reset-root').click(); const reset = (await messages(page)).at(-1);
    expect(reset.type).toBe('resetRoot'); await emit(page, { ...initial, root: '' }); await emit(page, { type: 'saved', id: reset.id });
    await expect(page.locator('#root')).toHaveValue(''); await expect(page.locator('#root')).toHaveAttribute('placeholder', '현재 열려있는 모든 파일');
    await expect(page.locator('#error')).toBeHidden();
});

test('current-directory selection exposes its window scope through edits and reset', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await openWebview(page, 'settings'); await emit(page, initial);
    await expect(page.locator('#window-root-description')).toBeHidden();
    await page.getByRole('button', { name: '현재 폴더로 설정 (이 창)', exact: true }).click();
    const selected = (await messages(page)).at(-1);
    expect(selected.type).toBe('currentDirectory');
    await emit(page, { ...initial, windowRoot: true });
    await emit(page, { type: 'saved', id: selected.id });
    await expect(page.locator('#window-root-description')).toContainText('이 창에만 적용됩니다.');
    await page.locator('#reset-root').click();
    await emit(page, { ...initial, root: '', windowRoot: true });
    await expect(page.locator('#root')).toHaveValue('');
    await expect(page.locator('#window-root-description')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
