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

test('document tabs stay visible and the empty article generates only on request', async ({ page }) => {
    await open(page);
    const memo = page.getByRole('tab', { name: '풀이 메모' });
    const article = page.getByRole('tab', { name: '본문 편집' });
    const draft = page.getByRole('button', { name: '이 메모로 초안 만들기' });
    const jobs = async () => (await messages(page)).filter((m: any) => ['prepare', 'generate'].includes(m.type));
    await model(page, { plan: undefined });
    await article.click();
    await page.getByRole('button', { name: '풀이 메모로 이동' }).click();
    await expect(memo).toBeFocused();
    await model(page, { backendEnabled: false });
    await article.click();
    await expect(draft).toBeDisabled();
    await model(page, { editable: false });
    await expect(draft).toBeDisabled();
    await model(page);
    await memo.click();
    await page.locator('#summary').fill('집합으로 중복 탐색을 피했다.');
    for (const [linked, available] of [[true, true], [false, false], [false, true]]) {
        await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { type: 'writerSidebar', linked, available });
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await expect(page.getByRole('tablist')).toBeInViewport();
        await memo.focus();
        await page.keyboard.press('ArrowRight');
        await expect(article).toBeFocused();
        await expect(draft).toBeVisible();
        await expect(page.locator('#format-bar')).toBeHidden();
        await page.keyboard.press('Home');
        await expect(page.locator('#summary')).toHaveValue('집합으로 중복 탐색을 피했다.');
    }
    await article.click();
    expect(await jobs()).toHaveLength(0);
    await draft.click();
    expect(await jobs()).toHaveLength(1);
    expect((await jobs())[0]).toMatchObject({ type: 'generate', fields: { plan: { summary: '집합으로 중복 탐색을 피했다.' } } });
});

test('AI-filled text and range can generate a complete draft without typing', async ({ page }) => {
    await open(page);
    await model(page);
    await expect(page.getByLabel('전체 설명', { exact: true })).toHaveValue(plan.summary);
    await expect(page.getByLabel('메모 #1 내용')).toHaveValue(plan.steps[0].body);
    await expect(page.locator('#range-info')).toContainText('#1–2');
    await page.getByRole('button', { name: '글쓰기' }).click();
    const request = (await messages(page)).find((m: any) => m.type === 'generate');
    expect(request.fields.plan).toEqual(plan);
    await model(page, { title: '완성 제목', markdown: '## 접근\n\n완성한 글입니다.' });
    await expect(page.locator('#article-view')).toBeVisible();
    await expect(page.locator('#article-title')).toHaveValue('완성 제목');
    expect((await messages(page)).some((m: any) => m.type === 'preview')).toBe(false);
    await expect(page.locator('#rich-editor')).toContainText('완성한 글입니다.');
    await expect(page.locator('#source-btn')).toBeHidden();
    await expect(page.locator('#preview-btn')).toBeHidden();
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
    await page.getByRole('button', { name: '글쓰기' }).click();
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
    await page.locator('#step-body-0').fill('보존할 수정 문장');
    await page.locator('#range-details > summary').click();
    await page.locator('#range-start').fill('1');
    await expect(page.locator('#step-body-0')).toBeHidden();
    await page.locator('#range-start').fill('0');
    await expect(page.locator('#step-body-0')).toHaveValue('보존할 수정 문장');
});

test('a rewrite streams into the read-only editor and keeps unsaved source edits when a candidate needs review', async ({ page }) => {
    await open(page);
    await model(page, { showAdvancedWritingViews: true, title: '이전 제목', markdown: '사용자가 쓴 본문' });
    await page.locator('#source-btn').click();
    await page.locator('#article-body').fill('작성 중에도 보존할 본문');
    const linkSidebar = (linked: boolean, available: boolean) => page.evaluate(data =>
        window.dispatchEvent(new MessageEvent('message', { data })), { type: 'writerSidebar', linked, available });
    await linkSidebar(true, true);
    await model(page, { showAdvancedWritingViews: true, pending: true, running: true, pendingKind: 'write_blog', title: '이전 제목', markdown: '사용자가 쓴 본문', streamMarkdown: '## 새로 생성 중\n\n본문이 먼저 보입니다.' });
    const heading = page.locator('.prose-editor').getByRole('heading', { name: '새로 생성 중' });
    await expect(heading).toBeInViewport();
    expect((await messages(page)).findLast((m: any) => m.type === 'writerControls').controls).not.toHaveProperty('stream');
    await linkSidebar(false, true);
    await expect(heading).toBeVisible();
    await linkSidebar(false, false);
    await expect(heading).toBeVisible();
    await linkSidebar(true, true);
    await expect(page.locator('#article-body')).toHaveValue('작성 중에도 보존할 본문');
    await model(page, { showAdvancedWritingViews: true, candidate: true, title: '이전 제목', markdown: '사용자가 쓴 본문' });
    await expect(heading).toHaveCount(0);
    await expect(page.locator('#candidate-box')).toHaveJSProperty('hidden', false);
    await expect(page.locator('#article-body')).toBeEditable();
    await expect(page.locator('#article-body')).toHaveValue('작성 중에도 보존할 본문');
});

test('partial text stays out of saves and undo history across a failed rewrite and retry', async ({ page }) => {
    await open(page);
    const draft = { title: '기존 제목', markdown: '원본' };
    await model(page, draft);
    const editor = page.locator('.prose-editor');
    await editor.click();
    await editor.press('End');
    await page.keyboard.insertText(' 수정');
    const writing = { ...draft, pending: true, running: true, pendingKind: 'write_blog' };
    await model(page, { ...writing, streamMarkdown: '## 첫 부분' });
    await model(page, { ...writing, streamMarkdown: '## 첫 부분\n\n- 다음 부분' });
    await expect(editor.getByRole('listitem')).toHaveText('다음 부분');
    await expect(page.locator('#copy-btn')).toBeDisabled();
    await expect(page.locator('#ghost-publish-btn')).toBeDisabled();
    await expect.poll(async () => (await messages(page)).filter((m: any) => m.type === 'save').map((m: any) => m.fields.markdown)).toEqual(['원본 수정']);
    await model(page, { ...writing, running: false, error: '연결 실패', streamMarkdown: '## 첫 부분' });
    await expect(editor).toBeEditable();
    await expect(editor).toHaveText('원본 수정');
    await expect(page.locator('#article-title')).toHaveValue(draft.title);
    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
    await expect(editor).toHaveText('원본');
    await expect.poll(async () => (await messages(page)).filter((m: any) => m.type === 'save').at(-1).fields.markdown).toBe('원본');
    const latest = (await messages(page)).filter((m: any) => m.type === 'save').at(-1);
    await page.evaluate(id => window.dispatchEvent(new MessageEvent('message', { data: { type: 'ack', id } })), latest.id);
    await model(page, { ...writing, streamMarkdown: '다시 쓰는 중' });
    await expect(editor).toHaveText('다시 쓰는 중');
    await model(page, { title: '완성한 제목', markdown: '완성한 본문' });
    await expect(editor).toHaveText('완성한 본문');
    await expect(editor).toBeEditable();
    await expect(page.locator('#article-title')).toBeEditable();
    await expect(page.locator('#article-title')).toHaveValue('완성한 제목');
});

test('cancelled initial preparation can restart without closing the writer', async ({ page }) => {
    await open(page);
    await model(page, { plan: undefined, pending: true, running: true });
    await page.locator('#cancel-btn').click();
    expect((await messages(page)).at(-1).type).toBe('cancel');
    await model(page, { plan: undefined, pending: false, running: false, status: '작업을 취소했습니다.' });
    await page.getByRole('button', { name: '메모 생성', exact: true }).click();
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

test('private notices follow the active memo, article, candidate and previous version', async ({ page }) => {
    const notice = { source: 'code', title: '경계값 <b>확인</b>', detail: '빈 입력에서 멈춥니다.', appliedFix: '빈 입력을 처리했습니다.' };
    await open(page);
    await model(page, { planNotices: [notice] });
    const toggle = page.getByRole('button', { name: '작성자 알림 1' });
    const memos = page.locator('#document-notices');
    await expect(memos).toBeHidden();
    const summaryTop = (await page.locator('#summary').boundingBox())!.y;
    await toggle.hover();
    const bounds = (await page.locator('#notice-panel').boundingBox())!;
    expect(page.viewportSize()!.width - bounds.x - bounds.width).toBeLessThan(24);
    expect((await page.locator('#summary').boundingBox())!.y).toBe(summaryTop);
    await expect(memos.locator('summary')).toHaveText('코드 · 경계값 <b>확인</b>');
    await expect(memos.locator('b')).toHaveCount(0);
    await expect(memos.getByText('메모에 반영', { exact: true })).toBeVisible();
    await expect(memos.getByText(notice.appliedFix)).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(memos).toBeHidden();
    await toggle.focus();
    await toggle.press('Enter');
    await expect(memos).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(memos).toBeHidden();
    await toggle.click();
    await memos.getByText(notice.detail).click();
    await page.mouse.move(0, 0);
    await expect(memos).toBeVisible();
    const article = { title: '글', markdown: '게시할 본문', versions, articleNotices: [{ ...notice, source: 'plan', title: '메모 확인', appliedFix: '' }] };
    await model(page, { ...article, candidate: true, candidateNotices: [notice] });
    await expect(page.locator('#notice-toggle')).toHaveText('작성자 알림 2');
    await expect(memos.locator('summary')).toHaveText('메모 · 메모 확인');
    await expect(memos).not.toContainText('본문에 반영');
    await expect(page.locator('#candidate-notices')).toBeVisible();
    await expect(page.locator('#rich-editor [contenteditable=true]')).toHaveText('게시할 본문');
    await page.locator('#version-select').selectOption('older');
    await page.evaluate(note => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'versionPreview', versionId: 'older', title: '예전', html: '<p>이전 본문</p>', notices: [note],
    } })), notice);
    await page.locator('#notice-toggle').hover();
    await expect(memos.getByRole('heading')).toHaveText('이전 버전 알림');
    await expect(memos.locator('summary')).toHaveText('코드 · 경계값 <b>확인</b>');
    await expect(memos).not.toContainText('메모 확인');
    await page.setViewportSize({ width: 320, height: 480 });
    await page.locator('#notice-toggle').hover();
    const narrowPanel = (await page.locator('#notice-panel').boundingBox())!;
    expect(narrowPanel.x).toBeGreaterThanOrEqual(0);
    expect(narrowPanel.height).toBeLessThanOrEqual(240);
    await page.locator('#version-select').selectOption('');
    await model(page, { ...article, articleNotices: [] });
    await expect(page.locator('#candidate-notices')).toBeHidden();
    await expect(page.locator('#notice-toggle')).toBeHidden();
});
test('article tools in the sidebar use the live draft and the selected version', async ({ page, context }) => {
    const sidebar = await context.newPage();
    await sidebar.setViewportSize({ width: 260, height: 700 });
    await Promise.all([open(page), open(sidebar, true)]);
    const deliver = (target: Page, data: unknown) => target.evaluate(message =>
        window.dispatchEvent(new MessageEvent('message', { data: message })), data);
    const refreshSidebar = async () => {
        const controls = (await messages(page)).findLast((m: any) => m.type === 'writerControls').controls;
        await deliver(sidebar, { type: 'sidebarWriter', writer: { filePath: base.filePath, fileName: base.fileName, controls } });
    };
    const clickTool = async (name: string) => {
        await sidebar.getByRole('button', { name, exact: true }).click();
        await deliver(page, (await messages(sidebar)).at(-1));
        await refreshSidebar();
    };
    await model(page);
    await deliver(page, { type: 'writerSidebar', linked: true, available: true });
    await refreshSidebar();
    const library = sidebar.locator('#file-library'), toggle = sidebar.locator('#library-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const libraryHeight = async () => (await toggle.boundingBox())!.height + (await library.boundingBox())!.height;
    expect(await libraryHeight()).toBeCloseTo(700 / 3, 0);
    await toggle.click();
    await refreshSidebar();
    await expect(library).toBeHidden();
    await toggle.click();
    await deliver(sidebar, { type: 'sidebarWriter', historyFile: base.filePath });
    await expect(library).toBeVisible();
    await expect(sidebar.locator('#writer-tools')).toBeHidden();
    expect(await libraryHeight()).toBeCloseTo(700 / 3, 0);
    const home = sidebar.getByRole('button', { name: '처음 화면', exact: true });
    await home.click();
    expect((await messages(sidebar)).at(-1)).toMatchObject({ type: 'sidebarHome', context: 'history', filePath: base.filePath });
    await expect(home).toBeHidden();
    await expect(toggle).toBeHidden();
    await expect(library).toBeVisible();
    await deliver(sidebar, { type: 'sidebarWriter', historyFile: base.filePath });
    await sidebar.setViewportSize({ width: 260, height: 480 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(library).toBeVisible();
    await refreshSidebar();
    await expect(library).toBeVisible();
    await home.click();
    expect((await messages(sidebar)).at(-1)).toMatchObject({ type: 'sidebarHome', context: 'writer', filePath: base.filePath });
    await expect(sidebar.locator('.config-section')).toBeVisible();
    await expect(sidebar.locator('#writer-tools')).toBeHidden();
    await expect(toggle).toBeHidden();
    await expect(library).toBeVisible();
    await refreshSidebar();
    await sidebar.setViewportSize({ width: 260, height: 700 });
    await expect(sidebar.getByRole('tablist', { name: '글 작성 화면' })).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveText(['풀이 메모', '본문 편집']);
    await expect(sidebar.getByRole('button', { name: '글쓰기', exact: true })).toBeVisible();
    await expect(sidebar.locator('#writer-article-options')).toBeHidden();
    await model(page, { pending: true, running: true, pendingKind: 'write_blog', status: '글을 작성하고 있어요…' });
    await refreshSidebar();
    await expect(sidebar.locator('#side-progress-box')).toHaveCount(0);
    await expect(sidebar.getByRole('button', { name: '글쓰기', exact: true })).toBeHidden();
    await clickTool('글 작성 취소');
    expect((await messages(page)).at(-1).type).toBe('cancel');
    const article = { title: '현재 제목', markdown: '## 접근\n\n현재 본문', versions };
    await model(page, { ...article, candidate: true });
    await refreshSidebar();
    await expect(sidebar.locator('#side-view-modes')).toBeHidden();
    await expect(sidebar.locator('#side-candidate-box button')).toHaveText(['새 결과 적용', '현재 내용 유지']);
    await expect(sidebar.locator('#side-candidate-box p')).toBeHidden();
    await expect(sidebar.locator('#side-history')).toBeVisible();
    await expect(sidebar.locator('#side-export')).toBeVisible();
    await model(page, { ...article, showAdvancedWritingViews: true });
    await refreshSidebar();
    const rewrite = sidebar.getByRole('button', { name: '글 다시 쓰기', exact: true });
    const buttonBottom = await rewrite.evaluate(button => button.getBoundingClientRect().bottom);
    for (const id of ['side-view-modes', 'side-history', 'side-outline', 'side-export']) {
        const section = sidebar.locator('#' + id);
        await expect(section).toBeVisible();
        expect(await section.evaluate(node => node.getBoundingClientRect().top)).toBeGreaterThanOrEqual(buttonBottom);
    }
    await expect(page.locator('#article-toolbar')).toBeHidden();
    await expect(page.locator('#format-bar')).toBeVisible();
    await sidebar.locator('#side-outline summary').click();
    await expect(sidebar.getByRole('button', { name: '접근', exact: true })).toBeVisible();
    await clickTool('Markdown');
    await page.locator('#article-body').fill('방금 고친 본문');
    await sidebar.locator('#side-export summary').click();
    await clickTool('Markdown 복사');
    expect((await messages(page)).findLast((m: any) => m.type === 'copy').fields.markdown).toBe('방금 고친 본문');
    await clickTool('이전 버전');
    await expect(page.locator('#version-preview')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '이 버전 사용' })).toBeDisabled();
    await versionPreview(page, 'newer');
    await refreshSidebar();
    await clickTool('Markdown 복사');
    expect((await messages(page)).findLast((m: any) => m.type === 'copy')).toMatchObject({ versionId: 'newer' });
    await clickTool('다음 버전');
    await expect(page.locator('#article-body')).toHaveValue('방금 고친 본문');
    await model(page, article);
    await refreshSidebar();
    await expect(sidebar.locator('#side-view-modes')).toBeHidden();
    await expect(page.locator('#rich-editor')).toContainText('방금 고친 본문');
    await deliver(page, { type: 'writerAction', filePath: base.filePath, action: 'source' });
    await expect(page.locator('#article-body')).toBeHidden();
    await model(page, { ...article, showAdvancedWritingViews: true });
    await refreshSidebar();
    await clickTool('미리보기');
    expect((await messages(page)).findLast((m: any) => m.type === 'preview').fields.markdown).toBe('방금 고친 본문');
    await deliver(page, { type: 'preview', html: '<p>방금 고친 본문</p>' });
    await expect(page.locator('#article-preview')).toBeVisible();
    await model(page, article);
    await deliver(page, { type: 'preview', html: '<p>늦게 도착한 미리보기</p>' });
    await expect(page.locator('#article-preview')).toBeHidden();
    await expect(page.locator('#format-bar')).toBeVisible();
    expect(await sidebar.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('sidebar export icons explain their actions and follow the Ghost connection', async ({ page, context }) => {
    const sidebar = await context.newPage();
    await sidebar.setViewportSize({ width: 205, height: 480 });
    await Promise.all([open(page), open(sidebar, true)]);
    const deliver = (target: Page, data: unknown) => target.evaluate(message =>
        window.dispatchEvent(new MessageEvent('message', { data: message })), data);
    const refresh = async () => {
        const controls = (await messages(page)).findLast((m: any) => m.type === 'writerControls').controls;
        await deliver(sidebar, { type: 'sidebarWriter', writer: { filePath: base.filePath, fileName: base.fileName, controls } });
    };
    await model(page, { title: '제목', markdown: '본문' });
    await deliver(page, { type: 'writerSidebar', linked: true, available: true });
    await refresh();
    const menu = sidebar.locator('#side-export');
    const summary = menu.locator('summary');
    await summary.click();
    const files = menu.getByRole('group', { name: '파일 저장 및 복사' });
    const ghost = menu.getByRole('group', { name: 'Ghost', exact: true });
    const tip = menu.getByRole('tooltip');
    await expect(files.getByRole('button')).toHaveCount(3);
    for (const name of ['Markdown 파일 저장', 'HTML 파일 저장', 'Markdown 복사']) {
        const control = files.getByRole('button', { name, exact: true });
        await expect(control).toHaveText('');
        await expect(control.locator('.codicon')).toHaveCount(1);
        await control.hover();
        await expect(tip).toHaveText(name);
    }
    await expect(ghost.getByRole('button')).toHaveCount(1);
    await expect(ghost.getByRole('button', { name: 'Ghost 연결 설정' })).toBeVisible();
    await sidebar.mouse.move(0, 0);
    await summary.focus();
    await sidebar.keyboard.press('Tab');
    await expect(files.getByRole('button', { name: 'Markdown 파일 저장' })).toBeFocused();
    await expect(tip).toHaveText('Markdown 파일 저장');
    await sidebar.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);

    const state = { connected: true, site: 'https://ghost.example/', postId: '42', editorUrl: 'https://ghost.example/ghost/' };
    await deliver(page, { type: 'ghost', state: { ...state, status: 'draft' } });
    await refresh();
    await expect(ghost.getByRole('button', { name: 'Ghost에 게시…' })).toBeEnabled();
    await expect(ghost.getByRole('button', { name: 'Ghost에서 열기' })).toBeEnabled();
    await deliver(page, { type: 'ghost', state: { ...state, status: 'published' } });
    await refresh();
    await expect(ghost.getByRole('button', { name: 'Ghost에 게시…' })).toHaveCount(0);
    await expect(ghost.getByRole('button', { name: 'Ghost 변경 사항 저장' })).toBeEnabled();
    await deliver(page, { type: 'ghost', state: { ...state, busy: true } });
    await refresh();
    const busy = ghost.getByRole('button', { name: 'Ghost 저장 중…' });
    await expect(busy).toBeDisabled();
    await busy.focus();
    await expect(tip).toHaveText('Ghost 저장 중…');
    const before = (await messages(sidebar)).length;
    await busy.press('Enter');
    expect((await messages(sidebar)).length).toBe(before);
    await deliver(page, { type: 'ghost', state: { connected: false } });
    await refresh();
    await expect(tip).toHaveCount(0);
    await expect(ghost.getByRole('button')).toHaveCount(1);
});

test('contest writing keeps tools in a local drawer and preserves the draft when the main sidebar returns', async ({ page }) => {
    await open(page);
    const sidebar = (linked: boolean, available: boolean) => page.evaluate(data =>
        window.dispatchEvent(new MessageEvent('message', { data })), { type: 'writerSidebar', linked, available });
    await model(page, { showAdvancedWritingViews: true, title: '초안', markdown: '현재 본문', backendEnabled: false });
    await sidebar(false, false);
    await expect(page.locator('#format-bar')).toBeVisible();
    await expect(page.locator('#article-toolbar')).toBeHidden();
    await page.getByRole('button', { name: '글쓰기 도구 열기' }).click();
    const drawer = page.getByRole('complementary', { name: '글쓰기 도구' });
    await expect(drawer.locator('#contest-backend-notice')).toBeVisible();
    await drawer.getByRole('button', { name: 'Markdown', exact: true }).click();
    await drawer.getByRole('button', { name: '도구 닫기' }).click();
    await page.locator('#article-body').fill('대회 중에 작성한 본문');
    await sidebar(true, true);
    await expect(page.locator('#article-body')).toHaveValue('대회 중에 작성한 본문');
    await expect(page.locator('#local-writer-tools #article-toolbar')).toHaveCount(0);
    await expect(page.locator('#article-toolbar')).toBeHidden();
});

test('version browsing preserves unsaved work, ignores late previews and restores by stable identity', async ({ page }) => {
    await open(page);
    await model(page, { showAdvancedWritingViews: true, title: '현재 제목', markdown: '현재 본문', versions });
    await page.locator('#source-btn').click();
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
    await model(page, { showAdvancedWritingViews: true, title: '현재 제목', markdown: '현재 본문', versions: [...versions, { id: 'latest', at: 1730000700000, title: '추가된 글' }], pending: true });
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
    await page.locator('#export-menu-btn').click();
    await page.locator('#copy-btn').click();
    expect((await messages(page)).at(-1)).toMatchObject({ type: 'copy', versionId: 'newer' });
    expect((await messages(page)).at(-1).fields).toBeUndefined();
    await page.locator('#export-menu-btn').click();
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
    await expect(page.getByRole('tab', { name: '풀이 메모', selected: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: '본문 편집', selected: false })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/writer-plan-narrow.png' });
});

test('an open writer preserves edits while contest switches independently control access and AI actions', async ({ page }) => {
    await open(page);
    await model(page);
    await page.locator('#summary').fill('작성 중인 메모');
    await model(page, { writingAllowed: false, backendEnabled: false });
    await expect(page.locator('#contest-writing-notice')).toBeVisible();
    await expect(page.locator('#summary')).toBeHidden();
    await model(page, { writingAllowed: true, backendEnabled: false });
    await expect(page.locator('#summary')).toHaveValue('작성 중인 메모');
    await expect(page.locator('#contest-backend-notice')).toBeVisible();
    await expect(page.locator('#generate-btn')).toBeDisabled();
    await model(page, { writingAllowed: true, backendEnabled: true });
    await expect(page.locator('#contest-backend-notice')).toBeHidden();
    await expect(page.locator('#generate-btn')).toBeEnabled();
});

test('contest request blocking also covers images in the editor and previews', async ({ page }) => {
    const origin = 'https://contest-images.example.test';
    const requests: string[] = [];
    await page.route(origin + '/**', route => {
        requests.push(route.request().url());
        return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    });
    await open(page);
    const article = { showAdvancedWritingViews: true, markdown: `![풀이](${origin}/editor)`,
        articleNotices: [{ source: 'code', title: '추가 설명', detail: `![그림](${origin}/notice)`, appliedFix: '' }] };
    await model(page, { ...article, backendEnabled: false });
    await page.evaluate(src => window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'preview', html: `<img src="${src}/preview">` },
    })), origin);
    for (const [container, path] of [['#rich-editor', 'editor'], ['#article-preview', 'preview'], ['#notice-panel', 'notice']]) {
        await expect(page.locator(`${container} img[data-blocked-src="${origin}/${path}"]`)).toHaveCount(1);
    }
    const onlineImages = page.locator(`img[src^="${origin}/"]`);
    await expect(onlineImages).toHaveCount(0);
    expect(requests).toEqual([]);
    await model(page, { ...article, backendEnabled: true });
    await expect.poll(() => new Set(requests).size).toBe(3);
    const writing = { ...article, pending: true, running: true, pendingKind: 'write_blog', streamMarkdown: `![그림](${origin}/stream)` };
    await model(page, writing);
    await expect(page.locator(`#rich-editor img[src="${origin}/stream"]`)).toBeVisible();
    await model(page, { ...writing, backendEnabled: false });
    await expect(onlineImages).toHaveCount(0);
});

test('existing notes stay editable and can be used for writing during automatic preparation', async ({ page }) => {
    await open(page);
    await model(page, { pending: true, running: true, pendingKind: 'prepare_blog', updatingMemos: true });
    await expect(page.locator('#memo-updating')).toBeVisible();
    await expect(page.locator('#generation-loading')).toBeHidden();
    await page.locator('#summary').fill('직접 수정한 설명');
    await page.getByRole('button', { name: '글쓰기', exact: true }).click();
    const request = (await messages(page)).find((m: any) => m.type === 'generate');
    expect(request.fields.plan.summary).toBe('직접 수정한 설명');
    expect(request.dirtyKeys).toContain('plan');
});
