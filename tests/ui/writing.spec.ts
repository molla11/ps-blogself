import { test, expect, Page } from '@playwright/test';
import { openWebview as open } from './webview';
const plan = {
    title: '중복 탐색을 줄인 풀이',
    summary: '반복되는 탐색을 집합 조회로 바꿨다.',
    start: 0,
    end: 1,
    steps: [
        {
            title: '조회 방식 변경',
            body: '중복 계산을 줄이기 위해 집합을 사용했다.',
            start: 0,
            end: 1,
        },
    ],
};
const base = {
    type: 'model',
    editable: true,
    editToken: 'window-a',
    filePath: '/work/solve.cpp',
    fileName: 'solve.cpp',
    plan,
    instructions: '',
    title: '',
    markdown: '',
    revision: 1,
    count: 2,
    times: [1, 2],
    pending: false,
    running: false,
    progress: 100,
    status: '준비됐어요.',
    error: '',
    candidate: false,
    versions: [],
};
async function model(page: Page, patch: any = {}) {
    await page.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), {
        ...base,
        ...patch,
    });
}
async function messages(page: Page) {
    return page.evaluate(() => (window as any).__messages);
}

test('the compact sidebar selects a file and starts writing without another navigation screen', async ({
    page,
}) => {
    await page.setViewportSize({ width: 300, height: 650 });
    await open(page, true);
    await page.evaluate(() =>
        window.dispatchEvent(
            new MessageEvent('message', {
                data: {
                    type: 'updateState',
                    root: '/work',
                    isRecording: true,
                    languages: ['cpp', 'py'],
                    totalLogSize: '10 KB',
                    recentLogs: Array.from({ length: 20 }, (_, i) => ({
                        fileName: `solve${i}.cpp`,
                        filePath: `/work/solve${i}.cpp`,
                        language: 'cpp',
                        lastModified: Date.now(),
                    })),
                },
            }),
        ),
    );
    await expect(page.getByRole('button', { name: '글 만들기', exact: true })).toBeInViewport();
    await page.getByText('solve1.cpp', { exact: true }).click();
    await page.getByRole('button', { name: '글 만들기', exact: true }).click();
    expect((await messages(page)).at(-1)).toMatchObject({
        type: 'generateBlog',
        path: '/work/solve1.cpp',
    });
    await expect(page.locator('#main-view')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    await page.screenshot({ path: 'test-results/sidebar.png' });
});

test('AI-filled text and range can generate a complete draft without typing', async ({ page }) => {
    await open(page);
    await model(page);
    await expect(page.getByLabel('전체 설명', { exact: true })).toHaveValue(plan.summary);
    await expect(page.getByLabel('1단계 설명')).toHaveValue(plan.steps[0].body);
    await expect(page.locator('#range-info')).toContainText('#1–2');
    await page.getByRole('button', { name: '이대로 글쓰기' }).click();
    const request = (await messages(page)).find((m: any) => m.type === 'generate');
    expect(request.fields.plan).toEqual(plan);
    await model(page, { title: '완성 제목', markdown: '## 접근\n\n완성한 글입니다.' });
    await expect(page.locator('#article-view')).toBeVisible();
    await expect(page.locator('#article-title')).toHaveValue('완성 제목');
    expect((await messages(page)).some((m: any) => m.type === 'preview')).toBe(true);
    await page.evaluate(() =>
        window.dispatchEvent(
            new MessageEvent('message', {
                data: { type: 'preview', html: '<h2>접근</h2><p>완성한 글입니다.</p>' },
            }),
        ),
    );
    await expect(page.locator('#article-preview')).toContainText('완성한 글입니다.');
    await page.getByRole('button', { name: '본문 수정' }).click();
    await expect(page.locator('#article-body')).toBeVisible();
    await page.screenshot({ path: 'test-results/writer.png' });
});

test('late saves and progress updates preserve input typed while a request is running', async ({
    page,
}) => {
    await open(page);
    await model(page);
    await page.locator('#summary').fill('첫 수정');
    await expect
        .poll(async () => (await messages(page)).filter((m: any) => m.type === 'save').length)
        .toBeGreaterThan(0);
    const first = (await messages(page)).find((m: any) => m.type === 'save');
    await page.locator('#summary').fill('응답을 기다리는 중 더 고친 문장');
    await page.evaluate(
        (id) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'ack', id } })),
        first.id,
    );
    await model(page, { pending: true, running: true, progress: 30 });
    await expect(page.locator('#summary')).toHaveValue('응답을 기다리는 중 더 고친 문장');
    expect((await page.evaluate(() => (window as any).__saved)).fields.plan.summary).toBe(
        '응답을 기다리는 중 더 고친 문장',
    );
});

test('single-change ranges remain valid and code containing HTML is rendered as text', async ({
    page,
}) => {
    await open(page);
    await model(page, {
        count: 1,
        times: [1],
        plan: { ...plan, end: 0, steps: [{ ...plan.steps[0], end: 0 }] },
    });
    await page.locator('#range-details > summary').click();
    expect(
        await page.locator('#timeline-range').evaluate((e) => e.getAttribute('style')),
    ).not.toContain('NaN');
    await page.locator('#steps summary').first().click();
    await expect
        .poll(async () => (await messages(page)).some((m: any) => m.type === 'diff'))
        .toBe(true);
    await page.evaluate(() =>
        window.dispatchEvent(
            new MessageEvent('message', {
                data: { type: 'diff', index: 0, text: '+<script>window.attacked=true</script>' },
            }),
        ),
    );
    await expect(page.locator('#steps pre')).toContainText('<script>');
    expect(await page.evaluate(() => (window as any).attacked)).toBeUndefined();
});

test('clicking generate flushes the latest explanation even before autosave', async ({ page }) => {
    await open(page);
    await model(page);
    await page.locator('#summary').fill('최종 설명');
    await page.getByRole('button', { name: '이대로 글쓰기' }).click();
    expect((await messages(page)).find((m: any) => m.type === 'generate').fields.plan.summary).toBe(
        '최종 설명',
    );
});

test('unsaved input is restored on reopen and candidates require an explicit apply', async ({
    page,
}) => {
    await open(page, false, {
        filePath: base.filePath,
        fields: { instructions: '닫기 전에 입력한 내용' },
    });
    await model(page, { candidate: true });
    await expect(page.locator('#instructions')).toHaveValue('닫기 전에 입력한 내용');
    await expect(page.locator('#summary')).toHaveValue(plan.summary);
    expect((await messages(page)).some((m: any) => m.type === 'applyCandidate')).toBe(false);
    await page.getByRole('button', { name: '새 결과 적용' }).click();
    expect((await messages(page)).some((m: any) => m.type === 'applyCandidate')).toBe(true);
});

test('narrowing and widening a range preserves edited step explanations', async ({ page }) => {
    await open(page);
    await model(page, {
        plan: {
            ...plan,
            steps: [
                { ...plan.steps[0], end: 0 },
                { title: '두 번째', body: '둘째 설명', start: 1, end: 1 },
            ],
        },
    });
    await page.getByLabel('1단계 설명').fill('보존할 수정 문장');
    await page.locator('#range-details > summary').click();
    await page.locator('#range-start').fill('1');
    await expect(page.getByLabel('1단계 설명')).toBeHidden();
    await page.locator('#range-start').fill('0');
    await expect(page.getByLabel('1단계 설명')).toHaveValue('보존할 수정 문장');
});

test('streaming shows a readable preview without replacing an edited article', async ({ page }) => {
    await open(page);
    await model(page, { title: '이전 제목', markdown: '사용자가 쓴 본문' });
    await page.locator('#article-body').fill('작성 중에도 보존할 본문');
    await model(page, { pending: true, running: true, title: '이전 제목', markdown: '사용자가 쓴 본문', streamHtml: '<h2>새로 생성 중</h2><p>본문이 먼저 보입니다.</p>' });
    await expect(page.locator('#stream-preview')).toContainText('본문이 먼저 보입니다.');
    await expect(page.locator('#article-body')).toHaveValue('작성 중에도 보존할 본문');
    await model(page, { streamHtml: '', candidate: true });
    await expect(page.locator('#stream-box')).toBeHidden();
    await expect(page.locator('#candidate-box')).toBeVisible();
    await expect(page.locator('#article-body')).toHaveValue('작성 중에도 보존할 본문');
});

test('cancelled initial preparation can restart without closing the writer', async ({ page }) => {
    await open(page);
    await model(page, { plan: undefined, pending: true, running: true });
    await page.locator('#cancel-btn').click();
    expect((await messages(page)).at(-1).type).toBe('cancel');
    await model(page, { plan: undefined, pending: false, running: false, status: '작업을 취소했습니다.' });
    await page.getByRole('button', { name: '풀이 준비', exact: true }).click();
    expect((await messages(page)).at(-1).type).toBe('prepare');
});

test('another window’s writer is read-only, follows live text, and can request editing ownership', async ({ page }) => {
    await open(page);
    await model(page, { editable: false, editToken: 'window-b' });
    await expect(page.locator('#ownership-box')).toBeVisible();
    await expect(page.locator('#summary')).toHaveJSProperty('readOnly', true);
    await expect(page.locator('#generate-btn')).toBeDisabled();
    await page.locator('#range-details > summary').click();
    await expect(page.locator('#range-start')).toBeDisabled();
    await model(page, { editable: false, editToken: 'window-b', plan: { ...plan, summary: '다른 창의 최신 수정' } });
    await expect(page.locator('#summary')).toHaveValue('다른 창의 최신 수정');
    await page.getByRole('button', { name: '이 창에서 편집', exact: true }).click();
    expect((await messages(page)).at(-1)).toMatchObject({ type: 'takeover', editToken: 'window-b' });
    expect((await messages(page)).at(-1).fields).toBeUndefined();
    await model(page, { editToken: 'new-window-a' });
    await expect(page.locator('#ownership-box')).toBeHidden();
    await expect(page.locator('#summary')).toHaveJSProperty('readOnly', false);
    await expect(page.locator('#generate-btn')).toBeEnabled();
});

test('losing ownership preserves unsaved input for explicit recovery', async ({ page }) => {
    await open(page);
    await model(page);
    await page.locator('#summary').fill('아직 저장하지 못한 설명');
    await model(page, { editable: false, editToken: 'window-b' });
    await expect(page.locator('#recovery-box')).toBeVisible();
    await expect(page.locator('#summary')).toHaveValue(plan.summary);
    await expect(page.locator('#recover-input-btn')).toBeDisabled();
    expect((await page.evaluate(() => (window as any).__saved)).localRecovery.plan.summary).toBe('아직 저장하지 못한 설명');
    await model(page, { editToken: 'new-window-a', plan: { ...plan, summary: '다른 창에서 저장한 설명' } });
    await expect(page.locator('#summary')).toHaveValue('다른 창에서 저장한 설명');
    await page.locator('#recover-input-btn').click();
    await expect(page.locator('#summary')).toHaveValue('아직 저장하지 못한 설명');
    expect((await messages(page)).at(-1)).toMatchObject({ type: 'save', editToken: 'new-window-a' });
    expect((await messages(page)).at(-1).fields.plan.summary).toBe('아직 저장하지 못한 설명');
});

test('reopening after an ownership change does not silently overwrite the newer saved draft', async ({ page }) => {
    await open(page, false, { filePath: base.filePath, editToken: 'old-owner', fields: { instructions: '이전 창의 미저장 입력' } });
    await model(page, { instructions: '다른 창의 최신 입력' });
    await expect(page.locator('#instructions')).toHaveValue('다른 창의 최신 입력');
    await expect(page.locator('#recovery-box')).toBeVisible();
    expect((await messages(page)).some((m: any) => m.type === 'save')).toBe(false);
});

const versions = [
    { id: 'older', at: 1730000000000, title: '처음 쓴 글' },
    { id: 'newer', at: 1730000600000, title: '두 번째 글' },
];
async function versionPreview(page: Page, versionId: string) {
    await page.evaluate((id) => window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'versionPreview', versionId: id, title: id + ' 제목', html: `<p>${id} 본문</p>` },
    })), versionId);
}

test('version browsing preserves unsaved work, ignores late previews and restores by stable identity', async ({ page }) => {
    await open(page);
    await model(page, { title: '현재 제목', markdown: '현재 본문', versions });
    await page.locator('#article-body').fill('아직 저장 중인 본문');
    await page.locator('#version-older-btn').click();
    await expect(page.locator('#version-select')).toHaveValue('newer');
    expect((await messages(page)).at(-1)).toMatchObject({ type: 'previewVersion', versionId: 'newer' });
    expect((await messages(page)).at(-1).fields).toBeUndefined();
    await expect(page.locator('#restore-version-btn')).toBeDisabled();
    await page.locator('#version-older-btn').click();
    await versionPreview(page, 'newer');
    await expect(page.locator('#version-body')).toBeEmpty();
    await versionPreview(page, 'older');
    await expect(page.locator('#version-body')).toHaveText('older 본문');
    await expect(page.locator('#current-article')).toBeHidden();
    expect((await messages(page)).some((m: any) => m.type === 'restore')).toBe(false);
    await model(page, { title: '현재 제목', markdown: '현재 본문', versions: [...versions, { id: 'latest', at: 1730000700000, title: '추가된 글' }], pending: true });
    await expect(page.locator('#version-select')).toHaveValue('older');
    await expect(page.locator('#version-body')).toHaveText('older 본문');
    await page.locator('#restore-version-btn').click();
    const restore = (await messages(page)).find((m: any) => m.type === 'restore');
    expect(restore).toMatchObject({ versionId: 'older', editToken: 'window-a', fields: { markdown: '아직 저장 중인 본문' } });
    expect(restore.index).toBeUndefined();
    await expect(page.locator('#restore-version-btn')).toBeDisabled();
    await page.evaluate(id => window.dispatchEvent(new MessageEvent('message', { data: { type: 'ack', id } })), restore.id);
    await model(page, { title: 'older 제목', markdown: 'older 본문', versions: [versions[1]] });
    await expect(page.locator('#version-select')).toHaveValue('');
    await expect(page.locator('#article-body')).toHaveValue('older 본문');
});

test('read-only windows can browse and copy versions without applying or saving them', async ({ page }) => {
    await open(page);
    await model(page, { editable: false, title: '현재 제목', markdown: '현재 본문', versions });
    await page.getByLabel('글 버전', { exact: true }).selectOption('newer');
    await versionPreview(page, 'newer');
    await expect(page.locator('#restore-version-btn')).toBeDisabled();
    await page.locator('#copy-btn').click();
    expect((await messages(page)).at(-1)).toMatchObject({ type: 'copy', versionId: 'newer' });
    expect((await messages(page)).at(-1).fields).toBeUndefined();
    await page.locator('#export-btn').click();
    expect((await messages(page)).at(-1)).toMatchObject({ type: 'export', versionId: 'newer' });
    await page.locator('#version-newer-btn').click();
    await expect(page.locator('#version-select')).toHaveValue('');
    await expect(page.locator('#current-article')).toBeVisible();
    await expect(page.locator('#article-body')).toHaveValue('현재 본문');
    expect((await messages(page)).some((m: any) => m.type === 'restore' || m.type === 'save')).toBe(false);
});

test('version selection supports keyboard navigation and fits narrow editors with long titles', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page);
    await model(page, { title: '현재 글', markdown: '본문', versions: versions.map(v => ({ ...v, title: v.title.repeat(30) })) });
    await page.locator('#version-select').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#version-select')).toHaveValue('newer');
    await versionPreview(page, 'newer');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/writer-versions-narrow.png' });
    await page.locator('#plan-tab').click();
    await expect(page.locator('#plan-tab')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#article-tab')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/writer-plan-narrow.png' });
});
