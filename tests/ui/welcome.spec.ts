import { test, expect } from '@playwright/test';
import { openWebview } from './webview';

const files = [
    { fileName: 'solve.cpp', filePath: '/work/graph/solve.cpp', language: 'cpp', lastModified: Date.UTC(2026, 10, 21, 7, 15) },
    { fileName: 'solve.cpp', filePath: '/work/tree/solve.cpp', language: 'cpp', lastModified: Date.UTC(2026, 10, 20, 12, 30) },
    { fileName: 'search.py', filePath: '/work/search.py', language: 'python', lastModified: Date.UTC(2026, 10, 19, 3, 40) },
];

for (const view of ['Welcome', 'recent files', 'full history']) {
    test(`${view} shows the original language and relative time as the clock advances`, async ({ page }) => {
        const now = Date.UTC(2026, 10, 21, 12);
        await page.clock.install({ time: new Date(now - 10000) });
        await page.clock.pauseAt(new Date(now));
        await openWebview(page, view === 'Welcome' ? 'welcome' : true);
        const rows = [{ ...files[2], lastModified: now + 1000 }];
        const message = view === 'Welcome' ? { type: 'codeFiles', total: 1, files: rows }
            : view === 'recent files' ? { type: 'recentLogsPage', recentLogs: rows }
            : { type: 'showFullLogs', logs: rows };
        await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
        const label = page.locator('time:visible');
        await expect(label).toHaveText('python • 방금');
        await page.clock.fastForward(1000);
        await expect(label).toHaveText('python • 방금');
        await page.clock.fastForward(59000);
        await expect(label).toHaveText('python • 59초 전');
        await page.clock.fastForward(1000);
        await expect(label).toHaveText('python • 1분 전');
        await page.clock.fastForward(59 * 60_000);
        await expect(label).toHaveText('python • 1시간 전');
        await page.clock.fastForward(23 * 3_600_000);
        await expect(label).toHaveText('python • 1일 전');
        await page.clock.fastForward(24 * 3_600_000);
        await expect(label).toHaveText('python • 2일 전');
    });
}

test('welcome accepts actions during discovery and opens the exact path from the live list', async ({ page }) => {
    await openWebview(page, 'welcome');
    await expect(page.locator('#files-status')).toContainText('찾는 중');
    const folder = page.getByRole('button', { name: '폴더 열기' });
    await expect(folder).toBeHidden();
    await expect(page.locator('[data-action="history"]')).toBeEnabled();
    await page.evaluate(files => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'codeFiles', searching: false, total: files.length, files,
    } })), files);
    await expect(page.locator('.file-link time').first()).toHaveAttribute('datetime', new Date(files[0].lastModified).toISOString());
    await expect(page.locator('#code-files')).not.toContainText(/열린 탭|현재 폴더|기록 없음/);
    await page.getByTitle('/work/tree/solve.cpp', { exact: true }).click();
    expect(await page.evaluate(() => (window as any).__messages.at(-1))).toEqual({
        type: 'action', action: 'openFile', path: '/work/tree/solve.cpp',
    });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'codeFiles', searching: false, total: 0, files: [],
    } })));
    await expect(page.locator('#files-status')).toContainText('.c, .cpp, .py');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'actionResult' } })));
    await expect(folder).toBeEnabled();
    await page.screenshot({ path: 'test-results/welcome-empty.png', fullPage: true });
    await folder.click();
    expect(await page.evaluate(() => (window as any).__messages.at(-1))).toEqual({ type: 'action', action: 'openFolder' });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'actionResult' } })));
    await expect(folder).toBeEnabled();
    await page.evaluate(files => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'codeFiles', searching: false, total: files.length, files,
    } })), files);
    await expect(folder).toBeHidden();
    await expect(page.locator('#file-count')).toHaveText('3개');
    await page.getByRole('button', { name: 'search.py 글쓰기' }).click();
    expect(await page.evaluate(() => (window as any).__messages.at(-1))).toEqual({
        type: 'action', action: 'write', path: '/work/search.py',
    });
});

test('welcome opens only the chosen action and stays idle until a click', async ({ page }) => {
    await openWebview(page, 'welcome');
    await expect(page.locator('.start h1')).toHaveText('PS-Blogself');
    await expect(page.locator('.start p')).toHaveText('알고리즘 문제를 풀면 바로 블로그를 만들어 드립니다.');
    await expect.poll(() => page.locator('.brand-icon').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(512);
    expect(await page.evaluate(() => (window as any).__messages)).toEqual([{ type: 'ready' }]);
    for (const action of ['connect', 'sample', 'history', 'settings']) {
        await page.locator(`[data-action="${action}"]`).click();
        expect(await page.evaluate(() => (window as any).__messages.at(-1))).toEqual({ type: 'action', action });
        await expect(page.locator('[data-action]:visible:disabled')).toHaveCount(4);
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'actionResult' } })));
        await expect(page.locator('[data-action]:disabled')).toHaveCount(0);
    }
});

test('keyboard actions prevent duplicate requests and recover after an error', async ({ page }) => {
    await openWebview(page, 'welcome');
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-action="connect"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await page.locator('[data-action="connect"]').dispatchEvent('click');
    expect(await page.evaluate(() => (window as any).__messages.filter((m: any) => m.type === 'action').length)).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'actionResult', error: '연결을 확인하고 다시 시도해 주세요.' } })));
    await expect(page.getByRole('alert')).toHaveText('연결을 확인하고 다시 시도해 주세요.');
    await page.locator('[data-action="connect"]').click();
    await expect(page.getByRole('alert')).toBeHidden();
    expect(await page.evaluate(() => (window as any).__messages.filter((m: any) => m.type === 'action').length)).toBe(2);
});

for (const [theme, width, stepRows] of [['dark', 1000, 1], ['light', 1000, 1], ['dark', 800, 2], ['dark', 360, 4]] as const) {
    test(`welcome remains readable in ${theme} at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 760 });
        await openWebview(page, 'welcome');
        await page.evaluate(files => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'codeFiles', searching: false, total: files.length, files,
        } })), files);
        if (theme === 'light') await page.evaluate(() => {
            document.body.classList.add('vscode-light');
            const style = document.createElement('style'); style.nonce = 'test-nonce';
            style.textContent = ':root { --vscode-editor-background: #ffffff; --vscode-foreground: #333333; --vscode-descriptionForeground: #616161; --vscode-widget-border: #d4d4d4; --vscode-textLink-foreground: #006ab1; }';
            document.head.append(style);
        });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const guide = page.getByRole('region', { name: '알고리즘 문제해결 블로그 완전 자동화' });
        await expect(guide.getByRole('heading', { level: 3 })).toHaveText(['자동 수정기록 저장', '자동 메모 생성', '블로그 생성&편집', '블로그 내보내기']);
        expect(await guide.getByRole('listitem').evaluateAll(steps => new Set(steps.map(step => step.getBoundingClientRect().top)).size)).toBe(stepRows);
        for (const button of await page.getByRole('button').all()) await expect(button).toBeVisible();
        await page.screenshot({ path: `test-results/welcome-${theme}-${width}.png`, fullPage: true });
    });
}
