import { test, expect } from '@playwright/test';
import { openWebview } from './webview';

for (const width of [1200, 1050, 640, 360]) {
    test(`block controls remain reachable across the gutter at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await openWebview(page);
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'model', filePath: '/work/solve.py', fileName: 'solve.py', editable: true, editToken: 'window-a',
            title: '블록 편집', markdown: '첫 번째 문단\n\n두 번째 문단', instructions: '', count: 1, times: [1], versions: [],
            pending: false, running: false, error: '', candidate: false,
            plan: { title: '블록 편집', summary: '풀이 과정', start: 0, end: 0, steps: [] },
        } })));
        const editor = page.getByRole('textbox', { name: '글 본문', exact: true });
        const handles = page.locator('.block-handle');
        const plus = handles.getByRole('button', { name: '이 아래에 블록 추가', exact: true });
        const grip = handles.getByRole('button', { name: '블록 이동', exact: true });
        async function approach(button: typeof plus) {
            const paragraph = editor.locator('p').first();
            await paragraph.hover({ position: { x: 60, y: 14 } });
            await expect(handles).toBeVisible();
            const block = (await paragraph.boundingBox())!, controls = (await handles.boundingBox())!, paper = (await page.locator('#current-article').boundingBox())!;
            expect(controls.x).toBeGreaterThanOrEqual(paper.x);
            expect(controls.x + controls.width).toBeLessThanOrEqual(block.x);
            const target = (await button.boundingBox())!, y = target.y + target.height / 2;
            // Cross the empty gap explicitly: a teleporting locator.click() misses this regression.
            await page.mouse.move(block.x + 30, y);
            await page.mouse.move((controls.x + controls.width + block.x) / 2, y, { steps: 12 });
            await expect(handles).toBeVisible();
            await page.mouse.move(target.x + target.width / 2, y, { steps: 12 });
            await expect(button).toBeVisible();
            expect(await button.evaluate(node => node.matches(':hover'))).toBe(true);
            await page.mouse.down(); await page.mouse.up();
        }
        await approach(grip);
        await expect(page.locator('#block-menu')).toBeVisible();
        await page.getByRole('button', { name: '아래로 이동', exact: true }).click();
        await expect(editor.locator('p').first()).toHaveText('두 번째 문단');
        await approach(plus);
        await expect(page.locator('#insert-menu')).toBeVisible();
        await page.locator('#insert-menu [data-insert="paragraph"]').click();
        await page.keyboard.insertText('추가한 문단');
        await expect(editor.locator('p').nth(1)).toHaveText('추가한 문단');
        await page.locator('#article-title').hover();
        await expect(handles).toBeHidden();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
}
