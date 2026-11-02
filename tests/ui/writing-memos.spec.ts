import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';
import { validatePlan } from '../../src/writing/model';

const plan = {
    title: '중복 탐색을 줄인 풀이', summary: '반복 탐색을 집합 조회로 바꿨다.', start: 0, end: 2,
    steps: [
        { title: '조회 방식 변경', body: '중복 계산을 줄이기 위해 집합을 사용했다.', start: 0, end: 1 },
        { title: '경계 조건 확인', body: '빈 입력에서도 올바른 결과가 나오는지 확인했다.', start: 2, end: 2 },
    ],
};
const base = {
    type: 'model', filePath: '/work/solve.cpp', fileName: 'solve.cpp', editable: true, editToken: 'window-a',
    plan, instructions: '', title: '', markdown: '', count: 3, times: [1, 2, 3], revision: 1,
    pending: false, running: false, status: '', error: '', candidate: false, versions: [],
};
async function model(page: Page, patch: Record<string, unknown> = {}) {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { ...base, ...patch });
}
const saved = (page: Page) => page.evaluate(() => (window as any).__saved);
const messages = (page: Page) => page.evaluate(() => (window as any).__messages);
const body = (page: Page, number: number) => page.getByRole('textbox', { name: `메모 #${number} 내용`, exact: true });
const after = (page: Page, number: number) => page.getByRole('button', { name: `메모 #${number} 뒤에 메모 추가`, exact: true });
const remove = (page: Page, number: number) => page.getByRole('button', { name: `메모 #${number} 삭제`, exact: true });

test.beforeEach(async ({ page }) => { await openWebview(page); await model(page); });

test('the summary stays visible below the title and separate memos form a thread at wide and narrow widths', async ({ page }) => {
    await expect(page.getByRole('button', { name: '변경사항 요약', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('textbox', { name: '전체 설명', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '전체 설명', exact: true })).toHaveValue(plan.summary);
    await expect(page.locator('#steps h3')).toHaveText(['메모 #1', '메모 #2']);
    for (const width of [1050, 500, 360, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const panel = (await page.locator('#plan-view').boundingBox())!;
        expect(panel.width).toBeLessThanOrEqual(640);
        const title = (await page.locator('#plan-title').boundingBox())!;
        const summary = (await page.locator('#summary').boundingBox())!;
        const titleCard = (await page.locator('.plan-title-section').boundingBox())!;
        const first = (await page.locator('.step').nth(0).boundingBox())!;
        const second = (await page.locator('.step').nth(1).boundingBox())!;
        expect(summary.y).toBeGreaterThan(title.y + title.height);
        expect(titleCard.y + titleCard.height).toBeGreaterThanOrEqual(summary.y + summary.height);
        expect(first.y).toBeGreaterThan(titleCard.y + titleCard.height);
        expect(second.y).toBeGreaterThan(first.y + first.height);
        expect(first.x).toBe(second.x);
        expect(first.x + first.width).toBeLessThanOrEqual(panel.x + panel.width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width === 1050 || width === 320) await page.screenshot({ path: `test-results/writing-memos-${width}.png`, fullPage: true });
    }
});

test('inserting at the start, middle and end and deleting memos preserves order in saves and generation', async ({ page }) => {
    await after(page, 1).click();
    await expect(body(page, 2)).toBeFocused();
    await body(page, 2).fill('중간에 추가한 이유');
    await expect(body(page, 3)).toHaveValue(plan.steps[1].body);
    await after(page, 3).click();
    await body(page, 4).fill('마지막 정리');
    await page.getByRole('button', { name: '첫 메모 추가', exact: true }).click();
    await body(page, 1).fill('먼저 확인한 조건');
    await remove(page, 3).click();
    await expect(body(page, 3)).toBeFocused();
    await expect(body(page, 3)).toHaveValue(plan.steps[1].body);
    await remove(page, 4).click();
    await expect(page.locator('#steps h3')).toHaveText(['메모 #1', '메모 #2', '메모 #3']);
    const expectedBodies = ['먼저 확인한 조건', plan.steps[0].body, plan.steps[1].body];
    await expect.poll(async () => (await messages(page)).filter((m: any) => m.type === 'save').at(-1)?.fields.plan.steps.map((s: any) => s.body)).toEqual(expectedBodies);
    const recovery = await saved(page);
    expect(recovery.fields.plan.summary).toBe(plan.summary);
    await openWebview(page, false, recovery);
    await model(page);
    await expect(body(page, 1)).toHaveValue(expectedBodies[0]);
    await page.locator('#generate-btn').click();
    const request = (await messages(page)).find((m: any) => m.type === 'generate');
    expect(request.fields.plan.steps.map((s: any) => s.body)).toEqual(expectedBodies);
    expect(validatePlan(request.fields.plan, base.count)).toEqual(request.fields.plan);
});

test('the last memo can be removed and an empty list can be rebuilt with the keyboard', async ({ page }) => {
    await remove(page, 2).click();
    await remove(page, 1).click();
    await expect(page.locator('.step')).toHaveCount(0);
    const add = page.getByRole('button', { name: '첫 메모 추가', exact: true });
    await expect(add).toBeFocused();
    expect((await saved(page)).fields.plan.steps).toEqual([]);
    await page.keyboard.press('Enter');
    await expect(body(page, 1)).toBeFocused();
    await body(page, 1).fill('새 메모');
    expect((await saved(page)).fields.plan.steps).toEqual([{ title: '', body: '새 메모', start: 0, end: 2 }]);
});

test('read-only ownership blocks structural edits and newer local memos survive late updates', async ({ page }) => {
    await model(page, { editable: false });
    await expect(after(page, 1)).toBeDisabled();
    await expect(remove(page, 1)).toBeDisabled();
    await expect(body(page, 1)).toHaveJSProperty('readOnly', true);
    await model(page);
    await after(page, 1).click();
    await body(page, 2).fill('저장 중인 메모');
    await expect.poll(async () => (await messages(page)).some((m: any) => m.type === 'save')).toBe(true);
    const firstSave = (await messages(page)).find((m: any) => m.type === 'save');
    await body(page, 2).fill('더 수정한 메모');
    await page.evaluate(id => window.dispatchEvent(new MessageEvent('message', { data: { type: 'ack', id } })), firstSave.id);
    await model(page, { pending: true, running: true });
    await expect(body(page, 2)).toBeFocused();
    await expect(body(page, 2)).toHaveValue('더 수정한 메모');
    await model(page, { editable: false, editToken: 'window-b' });
    expect((await saved(page)).localRecovery.plan.steps[1].body).toBe('더 수정한 메모');
    await expect(page.locator('.step')).toHaveCount(2);
    await expect(after(page, 1)).toBeDisabled();
});

test('new memos stay in the selected change range and filtered memos survive edits', async ({ page }) => {
    await page.locator('#range-details > summary').click();
    await page.locator('#range-start').fill('2');
    await expect(page.locator('#steps h3')).toHaveText(['메모 #1']);
    await expect(body(page, 1)).toHaveValue(plan.steps[1].body);
    await after(page, 1).click();
    await body(page, 2).fill('선택한 변경의 메모');
    expect((await saved(page)).fields.plan.steps[2]).toMatchObject({ start: 2, end: 2 });
    await remove(page, 1).click();
    await page.locator('#range-start').fill('0');
    await expect(body(page, 1)).toHaveValue(plan.steps[0].body);
    await expect(body(page, 2)).toHaveValue('선택한 변경의 메모');
});

test('the saved-plan limit disables insertion until a memo is removed', async ({ page }) => {
    await model(page, { plan: { ...plan, steps: Array.from({ length: 12 }, (_, i) => ({ ...plan.steps[0], title: `항목 ${i}` })) } });
    await expect(page.locator('.memo-add:enabled')).toHaveCount(0);
    await expect(page.locator('#memo-limit')).toBeVisible();
    await remove(page, 6).click();
    await expect(after(page, 5)).toBeEnabled();
    await after(page, 5).click();
    await body(page, 6).fill('대체 메모');
    expect(validatePlan((await saved(page)).fields.plan, base.count).steps).toHaveLength(12);
    await expect(page.locator('.memo-add:enabled')).toHaveCount(0);
});
