import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';
const markdown = '## 풀이의 출발점\n\n먼저 **중복 탐색**을 줄였다. [문제 링크](https://example.com/problem)를 참고했다.\n\n### 집합으로 조회하기\n\n3. 값을 저장한다.\n4. 집합에서 찾는다.\n\n| 방법 | 시간 |\n| --- | --- |\n| 순차 탐색 | O(n) |\n| 집합 조회 | O(1) |\n\n````python\nseen = set()\nprint("```")\n````\n\n- [x] 중복 입력 확인\n- [ ] 경계값 확인\n';
const base = { type: 'model', filePath: '/work/solve.py', fileName: 'solve.py', editable: true, editToken: 'window-a',
    instructions: '', title: '중복 탐색을 집합 조회로 바꾼 과정', markdown, count: 2, times: [1, 2], versions: [],
    pending: false, running: false, progress: 100, status: '', error: '', candidate: false,
    plan: { title: '중복 탐색을 집합 조회로 바꾼 과정', summary: '같은 값을 여러 번 찾던 반복문을 집합 조회로 바꿨다. 입력이 커질 때 탐색 비용이 쌓이는 부분을 먼저 줄였다.', start: 0, end: 1,
        steps: [{ title: '반복 탐색을 줄이기', body: '한 번 확인한 값을 집합에 저장하고, 다음 입력부터는 포함 여부만 확인한다.', start: 0, end: 1 }] } };
async function model(page: Page, patch: any = {}) { await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { ...base, ...patch }); }
async function messages(page: Page) { return page.evaluate(() => (window as any).__messages); }

test('rich reading and source mode preserve the exact original Markdown without creating saves', async ({ page }) => {
    await openWebview(page); await model(page);
    await expect(page.getByRole('textbox', { name: '글 본문', exact: true })).toBeVisible();
    await expect(page.locator('#rich-editor strong')).toHaveText('중복 탐색');
    await expect(page.locator('#rich-editor h3')).toHaveText('집합으로 조회하기');
    await expect(page.locator('#rich-editor ol')).toHaveAttribute('start', '3');
    await expect(page.locator('#rich-editor table')).toContainText('O(1)');
    await expect(page.locator('#rich-editor .code-block')).toContainText('print("```")');
    await page.locator('#source-btn').click();
    await expect(page.locator('#article-body')).toHaveValue(markdown);
    await page.locator('#source-btn').click();
    await page.locator('#export-menu-btn').click();
    await page.locator('#copy-btn').click();
    expect((await messages(page)).find((m: any) => m.type === 'copy').fields.markdown).toBe(markdown);
    expect((await messages(page)).some((m: any) => m.type === 'save')).toBe(false);
});

for (const width of [1050, 360]) {
    test(`switching editor modes keeps the viewport when the caret is at the end of a long article (${width}px)`, async ({ page }) => {
        await page.setViewportSize({ width, height: 740 });
        const longMarkdown = Array.from({ length: 80 }, (_, index) => `문단 ${index + 1}. 풀이 과정을 차례대로 설명한다.`).join('\n\n');
        await openWebview(page); await model(page, { markdown: longMarkdown });
        const rich = page.getByRole('textbox', { name: '글 본문', exact: true });
        const source = page.locator('#article-body');
        await rich.locator('p').last().click();
        await page.keyboard.press('End');
        await page.evaluate(() => scrollTo(0, 60));
        const before = await page.evaluate(() => scrollY);
        async function expectPosition() {
            // Tiptap restores focus on the next animation frame.
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            expect(Math.abs(await page.evaluate(() => scrollY) - before)).toBeLessThanOrEqual(2);
        }
        await page.locator('#source-btn').click();
        await expect(source).toBeFocused();
        await expectPosition();
        await expect(source).toHaveValue(longMarkdown);
        const caret = await source.evaluate((node: HTMLTextAreaElement) => node.selectionStart);
        await page.locator('#source-btn').click();
        await expect(rich).toBeFocused();
        await expectPosition();
        await page.locator('#source-btn').click();
        await expectPosition();
        expect(await source.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBe(caret);

        const html = new (require('markdown-it'))().render(longMarkdown);
        await page.evaluate(html => window.dispatchEvent(new MessageEvent('message', { data: { type: 'preview', html } })), html);
        await page.locator('#preview-btn').click();
        await expectPosition();
        await page.locator('#preview-btn').click();
        await expect(source).toBeFocused();
        await expectPosition();
        expect((await messages(page)).some((message: any) => message.type === 'save')).toBe(false);
    });
}

test('editing rich prose keeps marks, links, heading levels, ordered lists, tables and code fences in exported Markdown', async ({ page }) => {
    await openWebview(page); await model(page);
    await page.locator('#rich-editor p').first().click();
    await page.keyboard.press('End'); await page.keyboard.insertText(' 조회 비용을 비교했다.');
    await page.locator('#export-menu-btn').click(); await page.locator('#export-btn').click();
    const result = (await messages(page)).find((m: any) => m.type === 'export');
    expect(result.format).toBe('markdown');
    expect(result.fields.markdown).toContain('**중복 탐색**');
    expect(result.fields.markdown).toContain('[문제 링크](https://example.com/problem)');
    expect(result.fields.markdown).toContain('### 집합으로 조회하기');
    expect(result.fields.markdown).toContain('3. 값을 저장한다.');
    expect(result.fields.markdown).toContain('| 방법');
    expect(result.fields.markdown).toContain('````python\nseen = set()\nprint("```")\n````');
    expect(result.fields.markdown).toContain('[x] 중복 입력 확인');
});

test('formatting and undo keep working after save echoes, while another window cannot edit', async ({ page }) => {
    await openWebview(page); await model(page, { markdown: '짧은 설명' });
    const editor = page.getByRole('textbox', { name: '글 본문', exact: true });
    await editor.click(); await page.keyboard.press('ControlOrMeta+A');
    await page.getByRole('button', { name: '굵게', exact: true }).click();
    await expect(editor.locator('strong')).toHaveText('짧은 설명');
    await expect.poll(async () => (await messages(page)).filter((m: any) => m.type === 'save').length).toBeGreaterThan(0);
    const saved = (await messages(page)).filter((m: any) => m.type === 'save').at(-1);
    await page.evaluate(id => window.dispatchEvent(new MessageEvent('message', {data: {type: 'ack', id}})), saved.id);
    await model(page, { markdown: saved.fields.markdown });
    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
    await expect(editor.locator('strong')).toHaveCount(0);
    await model(page, { editable: false, editToken: 'window-b', markdown: '다른 창의 글' });
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await expect(page.getByRole('button', { name: '굵게', exact: true })).toBeDisabled();
    await expect(editor).toHaveText('다른 창의 글');
    await expect(page.locator('#recovery-box')).toBeVisible();
});

test('insert menu, link dialog, outline and export support direct keyboard interactions', async ({ page }) => {
    await openWebview(page); await model(page, { markdown: '' });
    await model(page, { markdown: '빈 문단' });
    const editor = page.getByRole('textbox', { name: '글 본문', exact: true });
    await editor.fill(''); await page.keyboard.press('/');
    await expect(page.locator('#slash-menu')).toBeVisible();
    await page.locator('#slash-menu').getByRole('option', { name: '제목', exact: true }).click();
    await page.keyboard.insertText('새 제목');
    await page.locator('#outline-toggle').click();
    await expect(page.locator('#outline-list')).toHaveText('새 제목');
    await editor.click(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: '링크', exact: true }).click();
    await page.locator('#insert-url').fill('https://example.com/guide');
    await page.locator('#url-form button[type=submit]').click();
    await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com/guide');
    await page.locator('#export-menu-btn').click(); await page.locator('#export-html-btn').click();
    expect((await messages(page)).filter((m: any) => m.type === 'export').at(-1)).toMatchObject({ format: 'html', fields: { title: base.title } });
    await page.locator('#export-menu-btn').click(); await page.keyboard.press('Escape');
    await expect(page.locator('#export-menu')).toBeHidden();
});

test('document layout stays usable in light, dark and narrow editor tabs', async ({ page }) => {
    await openWebview(page); await model(page);
    await page.locator('#outline-toggle').click();
    await page.screenshot({path: 'test-results/writer-editor-light.png', fullPage: true});
    await page.locator('#plan-tab').click();
    await page.screenshot({path: 'test-results/writer-preparation-light.png', fullPage: true});
    await page.locator('#article-tab').click();
    await page.evaluate(() => {
        document.body.className = 'vscode-dark';
        for (const [name, value] of Object.entries({'editor-background':'#1e1e1e', 'sideBar-background':'#252526', 'editor-foreground':'#d4d4d4', 'descriptionForeground':'#a7a7a7', 'widget-border':'#454545', 'button-background':'#0e639c', 'toolbar-hoverBackground':'#ffffff14', 'dropdown-background':'#313131', 'dropdown-foreground':'#ddd', 'input-background':'#313131', 'input-foreground':'#ddd', 'textCodeBlock-background':'#292929'})) document.documentElement.style.setProperty('--vscode-' + name, value);
    });
    await page.screenshot({path: 'test-results/writer-editor-dark.png', fullPage: true});
    await page.locator('#outline-toggle').click();
    await page.setViewportSize({width: 360, height: 740});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#export-menu-btn').click();
    await expect(page.locator('#export-html-btn')).toBeInViewport();
    await page.keyboard.press('Escape');
    await page.screenshot({path: 'test-results/writer-editor-narrow.png', fullPage: true});
});

test('Lexical document survives save echoes and the block menu moves a whole paragraph', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await openWebview(page); await model(page, { markdown: '첫 문단\n\n둘째 문단' });
    const editor = page.getByRole('textbox', { name: '글 본문', exact: true });
    await editor.locator('p').first().click(); await page.keyboard.press('End'); await page.keyboard.insertText(' 수정');
    await expect.poll(async () => (await messages(page)).filter((m: any) => m.type === 'save').length).toBeGreaterThan(0);
    const save = (await messages(page)).filter((m: any) => m.type === 'save').at(-1);
    expect(save.fields.document.root.children[0].children[0].text).toBe('첫 문단 수정');
    await model(page, save.fields);
    await editor.locator('p').first().hover();
    const grip = page.getByRole('button', { name: '블록 이동', exact: true });
    await expect(grip).toBeVisible(); await grip.click();
    await page.getByRole('button', { name: '아래로 이동', exact: true }).click();
    await expect(editor.locator('p').first()).toHaveText('둘째 문단');
    await expect(editor.locator('p').last()).toHaveText('첫 문단 수정');
    expect(errors).toEqual([]);
});

test('images load as blocks, edit their caption and persist pasted local assets', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await openWebview(page); await model(page, { markdown: '![풀이 그림](https://example.com/image.png "기존 캡션")\n\n마지막 문단' });
    const editor = page.getByRole('textbox', { name: '글 본문', exact: true });
    await expect(editor.locator('figure')).toHaveCount(1);
    await editor.locator('figure').click(); await page.locator('#image-caption').fill('바꾼 캡션'); await page.locator('#url-form button[type=submit]').click();
    await expect(editor.locator('figcaption')).toHaveText('바꾼 캡션');
    await editor.locator('p').last().click(); await page.keyboard.press('End');
    await editor.evaluate(node => {
        const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array([137,80,78,71,13,10,26,10])], 'paste.png', { type: 'image/png' }));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    await expect.poll(async () => (await messages(page)).some((m: any) => m.type === 'importImage')).toBe(true);
    const request = (await messages(page)).find((m: any) => m.type === 'importImage');
    const src = 'psb-image:' + 'a'.repeat(64);
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { type: 'imageReady', id: request.id, src, preview: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=' });
    await expect(editor.locator('figure')).toHaveCount(2);
    await expect.poll(async () => (await messages(page)).filter((m: any) => m.type === 'save').at(-1)?.fields.markdown.includes(src)).toBe(true);
    expect(errors).toEqual([]);
});

test('Ghost uses a current immutable snapshot and stays separate from local save status', async ({ page }) => {
    await openWebview(page); await model(page);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'ghost', state: { connected: true, site: 'https://example.com/' } } })));
    await page.locator('#article-title').fill('보낼 제목');
    await page.locator('#export-menu-btn').click(); await page.locator('#ghost-save-btn').click();
    const request = (await messages(page)).find((m: any) => m.type === 'ghostSave'); expect(request.fields.title).toBe('보낼 제목'); expect(request.fields.markdown).toBe(markdown);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'ghost', state: { connected: true, site: 'https://example.com/', busy: true } } })));
    await expect(page.locator('#ghost-status')).toContainText('계속 편집');
    await page.locator('#article-title').fill('저장 중 고친 제목');
    await expect(page.locator('#article-title')).toHaveValue('저장 중 고친 제목');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'ghost', state: { connected: true, site: 'https://example.com/', status: 'published', postId: '1', editorUrl: 'https://example.com/ghost/#/editor/post/1', synced: false } } })));
    await expect(page.locator('#ghost-status')).toContainText('변경 사항');
    await page.locator('#export-menu-btn').click(); await expect(page.locator('#ghost-save-btn')).toHaveText('Ghost 변경 사항 저장'); await expect(page.locator('#ghost-publish-btn')).toBeHidden();
    await page.locator('#ghost-open-btn').click(); expect((await messages(page)).at(-1).type).toBe('ghostOpen');
});
