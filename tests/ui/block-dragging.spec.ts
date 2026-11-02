import { test, expect, Page, Locator } from '@playwright/test';
import { openWebview } from './webview';

const base = {
    type: 'model', filePath: '/work/solve.py', fileName: 'solve.py', editable: true, editToken: 'window-a',
    title: '블록 이동', instructions: '', count: 1, times: [1], versions: [],
    pending: false, running: false, error: '', candidate: false,
    plan: { title: '블록 이동', summary: '풀이 과정', start: 0, end: 0, steps: [] },
};
async function open(page: Page, paragraphs: string[]) {
    await openWebview(page);
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { ...base, markdown: paragraphs.join('\n\n') });
}
async function startDrag(page: Page, target: string | Locator) {
    const block = typeof target === 'string' ? page.locator('.prose-editor > p').filter({ hasText: new RegExp('^' + target + '$') }) : target;
    await block.hover();
    const grip = page.getByRole('button', { name: '블록 이동', exact: true });
    await expect(grip).toBeVisible();
    const rect = (await grip.boundingBox())!;
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width + 20, rect.y + rect.height / 2, { steps: 8 });
}
async function edge(page: Page, side: 'top' | 'bottom') {
    const rect = (await page.locator('#rich-editor').boundingBox())!;
    return { x: rect.x + 100, y: side === 'top' ? rect.y - 8 : rect.y + rect.height + 8 };
}
async function drop(page: Page, position: { x: number; y: number }) {
    await page.mouse.move(position.x, position.y, { steps: 15 });
    // Chromium needs another dragover at the final coordinates before mouseup.
    await page.mouse.move(position.x, position.y);
    await page.mouse.up();
}

for (const width of [1050, 360]) {
    for (const side of ['top', 'bottom'] as const) {
        test(`dragging into ${side} paper padding moves a block to the edge at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 1200 });
            await open(page, ['첫 문단', '가운데 문단', '마지막 문단']);
            await startDrag(page, '가운데 문단');
            await drop(page, await edge(page, side));
            const expected = side === 'top' ? ['가운데 문단', '첫 문단', '마지막 문단'] : ['첫 문단', '마지막 문단', '가운데 문단'];
            await expect(page.locator('.prose-editor > p')).toHaveText(expected);
            await expect(page.locator('#block-menu')).toBeHidden();
            await page.getByRole('button', { name: '실행 취소', exact: true }).click();
            await expect(page.locator('.prose-editor > p')).toHaveText(['첫 문단', '가운데 문단', '마지막 문단']);
            await page.getByRole('button', { name: '다시 실행', exact: true }).click();
            await expect(page.locator('.prose-editor > p')).toHaveText(expected);
        });
    }
}

for (const side of ['top', 'bottom'] as const) {
    test(`dragging while scrolling to the ${side} uses the displayed insertion boundary`, async ({ page }) => {
        await page.setViewportSize({ width: 1050, height: 800 });
        const paragraphs = Array.from({ length: 30 }, (_, index) => `문단 ${index + 1}`);
        await open(page, paragraphs);
        await startDrag(page, '문단 15');
        await page.evaluate(side => {
            // Keep the top drop boundary below the pinned writing and format controls.
            const editorTop = document.getElementById('rich-editor')!.getBoundingClientRect().top + scrollY;
            const controlsBottom = document.getElementById('format-bar')!.getBoundingClientRect().bottom;
            scrollTo(0, side === 'top' ? editorTop - controlsBottom - 24 : document.documentElement.scrollHeight);
        }, side);
        const position = await edge(page, side);
        await page.mouse.move(position.x, position.y, { steps: 15 });
        await page.mouse.move(position.x, position.y);
        const firstOrLast = page.locator('.prose-editor > p')[side === 'top' ? 'first' : 'last']();
        const boundary = (await firstOrLast.boundingBox())!;
        await expect(page.locator('.block-drop-line')).toHaveCSS('opacity', '0.4');
        const line = (await page.locator('.block-drop-line').boundingBox())!;
        expect(Math.abs(line.y + line.height / 2 - (side === 'top' ? boundary.y : boundary.y + boundary.height))).toBeLessThanOrEqual(2);
        await page.mouse.up();
        const rest = paragraphs.filter(text => text !== '문단 15');
        await expect(page.locator('.prose-editor > p')).toHaveText(side === 'top' ? ['문단 15', ...rest] : [...rest, '문단 15']);
    });
}

test('cancelling a drag clears the insertion line and the next drag still works', async ({ page }) => {
    await page.setViewportSize({ width: 1050, height: 1200 });
    await open(page, ['첫 문단', '가운데 문단', '마지막 문단']);
    await startDrag(page, '가운데 문단');
    const target = await edge(page, 'top');
    await page.mouse.move(target.x, target.y, { steps: 12 });
    await expect(page.locator('.block-drop-line')).toHaveCSS('opacity', '0.4');
    await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(page.locator('.block-drop-line')).toHaveCSS('opacity', '0');
    await expect(page.locator('.prose-editor > p')).toHaveText(['첫 문단', '가운데 문단', '마지막 문단']);
    expect(await page.evaluate(() => (window as any).__messages.some((message: any) => message.type === 'save'))).toBe(false);
    await startDrag(page, '가운데 문단');
    await drop(page, await edge(page, 'top'));
    await expect(page.locator('.prose-editor > p')).toHaveText(['가운데 문단', '첫 문단', '마지막 문단']);
});

test('dropping an edge block in its own position is a no-op, including a single-block document', async ({ page }) => {
    await page.setViewportSize({ width: 1050, height: 1200 });
    await open(page, ['첫 문단', '마지막 문단']);
    await startDrag(page, '첫 문단'); await drop(page, await edge(page, 'top'));
    await startDrag(page, '마지막 문단'); await drop(page, await edge(page, 'bottom'));
    await expect(page.locator('.prose-editor > p')).toHaveText(['첫 문단', '마지막 문단']);
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { ...base, markdown: '하나뿐인 문단' });
    await startDrag(page, '하나뿐인 문단'); await drop(page, await edge(page, 'bottom'));
    await expect(page.locator('.prose-editor > p')).toHaveText(['하나뿐인 문단']);
    await expect(page.locator('.block-drop-line')).toHaveCSS('opacity', '0');
    expect(await page.evaluate(() => (window as any).__messages.some((message: any) => message.type === 'save'))).toBe(false);
});

test('losing edit ownership during a drag prevents reordering', async ({ page }) => {
    await page.setViewportSize({ width: 1050, height: 1200 });
    const paragraphs = ['첫 문단', '가운데 문단', '마지막 문단'];
    await open(page, paragraphs);
    await startDrag(page, '가운데 문단');
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), {
        ...base, markdown: paragraphs.join('\n\n'), editable: false, editToken: 'window-b',
    });
    await drop(page, await edge(page, 'top'));
    await expect(page.locator('.prose-editor > p')).toHaveText(paragraphs);
    await expect(page.locator('.block-drop-line')).toHaveCSS('opacity', '0');
    expect(await page.evaluate(() => (window as any).__messages.some((message: any) => message.type === 'save'))).toBe(false);
});

test('a code block moves intact to either edge and retains its syntax highlighting', async ({ page }) => {
    await page.setViewportSize({ width: 1050, height: 1200 });
    const code = 'int main() {\n    return 42;\n}';
    await open(page, ['첫 문단', '```cpp\n' + code + '\n```', '마지막 문단']);
    const block = page.locator('.code-block');
    async function highlighted() {
        return page.evaluate(() => [...(CSS as any).highlights.values()].flatMap((highlight: any) => [...highlight]).some((range: any) => document.querySelector('.code-block')!.contains(range.startContainer) && range.toString() === 'return'));
    }
    await expect.poll(highlighted).toBe(true);
    for (const side of ['top', 'bottom'] as const) {
        await startDrag(page, block); await drop(page, await edge(page, side));
        const endpoint = page.locator('.prose-editor > *')[side === 'top' ? 'first' : 'last']();
        await expect(endpoint).toHaveClass('code-block');
        expect(await block.textContent()).toBe(code);
        await expect.poll(highlighted).toBe(true);
    }
    await page.locator('#source-btn').click();
    await expect(page.locator('#article-body')).toHaveValue('첫 문단\n\n마지막 문단\n\n```cpp\n' + code + '\n```');
});
