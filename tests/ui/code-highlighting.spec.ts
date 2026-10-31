import { test, expect, Page } from '@playwright/test';
import { openWebview } from './webview';
import MarkdownIt from 'markdown-it';

const base = {
    type: 'model', filePath: '/work/solve.cpp', fileName: 'solve.cpp', editable: true, editToken: 'window-a',
    title: '코드 설명', instructions: '', markdown: '', count: 1, times: [1], versions: [],
    pending: false, running: false, error: '', candidate: false,
    plan: { title: '코드 설명', summary: '풀이 과정', start: 0, end: 0, steps: [] },
};
const fence = (language: string, source: string) => '```' + language + '\n' + source + '\n```';
async function message(page: Page, data: Record<string, unknown>) {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
}
async function tokens(page: Page, selector: string) {
    return page.evaluate(selector => {
        const element = document.querySelector(selector)!;
        return [...(CSS as any).highlights.entries()].filter(([name]) => name.startsWith('psb-code-')).flatMap(([name, highlight]) =>
            [...highlight].filter((range: any) => element.contains(range.startContainer)).map((range: any) => ({
                text: range.toString(), color: getComputedStyle(range.startContainer.parentElement, `::highlight(${name})`).color,
            })));
    }, selector);
}

test('C, C++, Python and language aliases are colored without modifying source or creating saves', async ({ page }) => {
    const samples = [
        ['c', 'int main() { return 42; }'], ['c++', 'std::string value = "hello";'],
        ['py', '# 설명\nprint("<script>literal</script>")'], ['text', 'plain = 1'], ['unknown-language', 'return 3'],
    ];
    const markdown = samples.map(([language, source]) => fence(language, source)).join('\n\n');
    await openWebview(page);
    await message(page, { ...base, markdown });
    for (let index = 0; index < 3; index++) {
        await expect.poll(async () => new Set((await tokens(page, `.code-block:nth-child(${index + 1})`)).map(token => token.color)).size).toBeGreaterThan(1);
    }
    expect(await tokens(page, '.code-block:nth-child(4)')).toEqual([]);
    expect(await tokens(page, '.code-block:nth-child(5)')).toEqual([]);
    await expect(page.locator('#rich-editor script')).toHaveCount(0);
    await page.locator('#source-btn').click();
    await expect(page.locator('#article-body')).toHaveValue(markdown);
    await page.locator('#source-btn').click();
    await page.locator('#export-menu-btn').click(); await page.locator('#copy-btn').click();
    const messages = await page.evaluate(() => (window as any).__messages);
    expect(messages.find((item: any) => item.type === 'copy').fields.markdown).toBe(markdown);
    expect(messages.some((item: any) => item.type === 'save')).toBe(false);
});

test('editing, language changes and undo refresh colors without disturbing the caret', async ({ page }) => {
    const markdown = fence('javascript', 'const answer = 1;');
    await openWebview(page); await message(page, { ...base, markdown });
    const code = page.locator('.code-block');
    await expect.poll(async () => (await tokens(page, '.code-block')).length).toBeGreaterThan(0);
    await code.click(); await page.keyboard.press('End');
    await page.keyboard.press('Enter'); await page.keyboard.insertText('// next');
    await expect.poll(async () => (await tokens(page, '.code-block')).some(token => token.text.includes('// next'))).toBe(true);
    await page.keyboard.insertText(' line');
    await expect(code).toContainText('// next line');
    await page.locator('#code-language').selectOption('');
    await expect.poll(() => tokens(page, '.code-block')).toEqual([]);
    await page.locator('#code-language').selectOption('javascript');
    await expect.poll(async () => (await tokens(page, '.code-block')).length).toBeGreaterThan(0);
    await page.locator('#source-btn').click();
    await expect(page.locator('#article-body')).toHaveValue(fence('javascript', 'const answer = 1;\n// next line'));
    await page.locator('#source-btn').click();
    await code.click(); await page.keyboard.press('End');
    await page.keyboard.insertText(' extra');
    await expect(code).toContainText(' extra');
    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
    await expect(code).not.toContainText(' extra');
    await expect.poll(async () => (await tokens(page, '.code-block')).some(token => token.text.includes('extra'))).toBe(false);
});

test('preview, streamed output and previous versions preserve literal code while highlighting it', async ({ page }) => {
    const markdown = fence('python', 'if value < 3:\n\tprint("<script>alert(1)</script>")');
    const html = new MarkdownIt({ html: false }).render(markdown);
    await openWebview(page);
    await message(page, { ...base, markdown, streamHtml: html, versions: [{ id: 'old', at: 1, title: '이전 글' }] });
    await expect.poll(async () => (await tokens(page, '#stream-preview')).length).toBeGreaterThan(0);
    await message(page, { type: 'preview', html });
    await expect.poll(async () => (await tokens(page, '#article-preview')).length).toBeGreaterThan(0);
    await page.locator('#version-select').selectOption('old');
    await message(page, { type: 'versionPreview', versionId: 'old', title: '이전 글', html });
    await expect.poll(async () => (await tokens(page, '#version-body')).length).toBeGreaterThan(0);
    for (const id of ['stream-preview', 'article-preview', 'version-body']) {
        expect(await page.locator(`#${id} code`).textContent()).toBe('if value < 3:\n\tprint("<script>alert(1)</script>")\n');
        await expect(page.locator(`#${id} script`)).toHaveCount(0);
    }
    await message(page, { type: 'preview', html: '<p>코드 없음</p>' });
    await expect.poll(() => tokens(page, '#article-preview')).toEqual([]);
    // Detached DOM ranges are removed, without clearing other visible surfaces.
    await expect.poll(async () => page.evaluate(() => [...(CSS as any).highlights.values()].every((highlight: any) => [...highlight].every((range: any) => range.startContainer.isConnected)))).toBe(true);
    expect((await tokens(page, '#version-body')).length).toBeGreaterThan(0);
});

test('highlight colors follow VS Code light, dark and high contrast themes', async ({ page }) => {
    await openWebview(page); await message(page, { ...base, markdown: fence('cpp', 'int main() { return 42; }') });
    await expect.poll(async () => (await tokens(page, '.code-block')).length).toBeGreaterThan(0);
    const light = await tokens(page, '.code-block');
    await page.evaluate(() => document.body.classList.add('vscode-dark'));
    const dark = await tokens(page, '.code-block');
    expect(dark.map(token => token.text)).toEqual(light.map(token => token.text));
    expect(dark.map(token => token.color)).not.toEqual(light.map(token => token.color));
    await page.evaluate(() => { document.body.className = 'vscode-high-contrast'; });
    expect(await tokens(page, '.code-block')).toEqual(dark);
    await page.evaluate(() => { document.body.className = 'vscode-high-contrast-light'; });
    expect(await tokens(page, '.code-block')).toEqual(light);
});
