const vscode = require('vscode');
const { checkGhostExport, installGhostFixture } = require('./ghost.cjs');
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, description) {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
        try {
            const value = await fn();
            if (value) return value;
        } catch {}
        await sleep(150);
    }
    throw new Error('Timed out: ' + description);
}
async function surface(browser, selector) {
    return until(async () => {
        for (const context of browser.contexts())
            for (const page of context.pages())
                for (const frame of page.frames()) {
                    try {
                        if (await frame.locator(selector).count()) return { page, frame };
                    } catch {}
                }
    }, selector);
}
exports.run = async () => {
    const sandbox = process.env.PSB_HOST_SANDBOX, stage = process.env.PSB_HOST_STAGE;
    const autoMode = process.env.PSB_TEST_AUTO_GHOST_MODE;
    const restoreFetch = installGhostFixture(sandbox);
    const extension = vscode.extensions.all.find(e => e.packageJSON.name === 'ps-blogself');
    await extension.activate();
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.PSB_CDP_PORT}`);
    const requests = async () => (await fetch(process.env.PSB_API_URL.replace(/\/api$/, '') + '/__test/requests')).json();
    try {
        const welcomeTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.label === 'Welcome · PS-Blogself');
        assert.equal(welcomeTabs().length, stage === 'first' ? 1 : 0, 'welcome opens once, not on restart');
        await vscode.commands.executeCommand('psb.welcome');
        await until(() => welcomeTabs().length === 1, 'manual welcome tab is created');
        await vscode.commands.executeCommand('psb.welcome');
        assert.equal(welcomeTabs().length, 1, 'manual welcome reuses its existing tab');
        const welcome = await surface(browser, '#welcome');
        if (stage === 'first') {
            assert.equal((await requests()).length, 0, 'welcome does not start AI work');
            await welcome.frame.locator('[data-action="connect"]').click();
            await until(async () => !(await welcome.frame.locator('[data-action="connect"]').isDisabled()), 'welcome account action completes');
            assert.equal((await requests()).length, 0, 'login does not start AI work');
            await welcome.frame.locator('[data-action="settings"]').click();
            const settings = await surface(browser, '#root-form');
            await settings.frame.locator('#root').waitFor();
            await settings.frame.locator('#exportTags').fill(' PS, segment tree, ps, 알고리즘, ');
            await settings.frame.locator('#save-exportTags').click();
            await until(() => JSON.stringify(vscode.workspace.getConfiguration('psb').get('exportTags')) === JSON.stringify(['PS', 'segment tree', '알고리즘']), 'export tags persist through the settings page');
            if (autoMode) {
                assert.ok(['draft', 'publish'].includes(autoMode));
                await settings.frame.locator('#connect-ghost').click();
                const input = settings.page.locator('.quick-input-widget input');
                await input.waitFor({ state: 'visible' }); await input.fill('https://ghost.psb.test'); await input.press('Enter');
                await until(async () => (await settings.page.locator('.quick-input-title').innerText()).includes('Admin API'), 'automatic upload Ghost key prompt');
                await input.fill('123456789012345678901234:' + 'ab'.repeat(32)); await input.press('Enter');
                await until(async () => (await settings.frame.locator('#status').innerText()) === '저장됨', 'Ghost connection configured from settings');
                await settings.frame.locator('#ghost-auto-upload').check();
                if (autoMode === 'publish') await settings.frame.locator('#ghost-auto-mode').selectOption('publish');
                await until(() => vscode.workspace.getConfiguration('psb').get('ghostAutoUpload') === true && vscode.workspace.getConfiguration('psb').get('ghostAutoUploadMode') === autoMode, 'automatic upload settings saved');
                assert.deepEqual(JSON.parse(await fs.readFile(path.join(sandbox, 'ghost-posts.json'), 'utf8').catch(() => '[]')), [], 'enabling automatic upload does not publish existing content');
            }
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await vscode.commands.executeCommand('psb.welcome');
            await welcome.frame.locator('[data-action="history"]').click();
            await surface(browser, '#generate-blog-btn');
            await welcome.page.screenshot({ path: path.join(sandbox, 'welcome.png') });
        }
        await vscode.window.tabGroups.close(welcomeTabs());
        assert.deepEqual(vscode.workspace.getConfiguration('psb').get('exportTags'), ['PS', 'segment tree', '알고리즘'], 'export tags survive restart');
        await until(() => welcomeTabs().length === 0, 'welcome tab closes');
        if (stage === 'first') {
            const doc = await vscode.workspace.openTextDocument(path.join(sandbox, 'workspace/solve.py'));
            const editor = await vscode.window.showTextDocument(doc);
            for (const content of ['print(1 + 2)\n', 'print(1 + 2 + 3)\n']) {
                await editor.edit(edit => edit.replace(new vscode.Range(0, 0, doc.lineCount, 0), content));
                await doc.save();
            }
        }
        await vscode.commands.executeCommand('psb.sidebar.focus');
        const sidebar = await surface(browser, '#generate-blog-btn');
        await until(async () => (await sidebar.frame.locator('.log-name').allTextContents()).includes('solve.py'), 'recorded file');
        const writingCounts = sidebar.frame.locator('.log-item').filter({ has: sidebar.frame.getByText('solve.py', { exact: true }) }).locator('.log-writing');
        if (stage === 'first') {
            assert.equal((await requests()).length, 0, 'ordinary saves must not trigger AI');
            await sidebar.frame.getByText('solve.py', { exact: true }).click({ button: 'right' });
            await sidebar.frame.locator('#ctx-view-history').click();
            const history = await surface(browser, '#write-btn');
            await until(async () => (await history.frame.locator('#preparation-status').innerText()).includes('끝났어요'), 'history prepares AI automatically');
            await until(async () => (await writingCounts.innerText()).includes('메모 1'), 'prepared note bundle appears on its file row');
            assert.equal(await writingCounts.locator('.log-unread').count(), 0, 'prepared notes never show unread notifications');
            assert.equal((await requests()).length, 1);
            await history.frame.locator('#write-btn').click();
        } else {
            await sidebar.frame.getByText('solve.py', { exact: true }).click();
            await sidebar.frame.locator('#generate-blog-btn').click();
        }
        const writer = await surface(browser, '#generate-btn');
        await until(async () => !(await writer.frame.locator('#generate-btn').isDisabled()), 'prepared plan reused');
        if (stage === 'first') {
            assert.equal(await writingCounts.locator('.log-unread').count(), 0, 'opening notes does not create an article notification');
            assert.equal(await writer.frame.locator('#summary').inputValue(), 'AI가 미리 정리한 설명');
            assert.equal((await requests()).length, 1, 'opening writer must reuse preparation');
            await writer.frame.locator('#summary').fill('서버 경로에서 수정한 의도');
            await writer.frame.locator('#generate-btn').click();
            await until(async () => (await writer.frame.locator('#stream-preview').innerText()).includes('생성 중인 본문'), 'stream visible before completion');
            assert.ok(await writer.frame.locator('#generate-btn').isDisabled());
            await writer.page.screenshot({ path: path.join(sandbox, 'streaming.png') });
            if (!autoMode) await vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
            if (autoMode === 'publish') {
                await writer.frame.locator('#summary').fill('생성 중 수정한 풀이 의도');
                await until(async () => (await writer.frame.locator('#save-status').innerText()) === '저장됨', 'concurrent edits saved before generation finishes');
                await until(async () => await writer.frame.locator('#candidate-box').isVisible(), 'edited draft defers the generated candidate');
                assert.deepEqual(JSON.parse(await fs.readFile(path.join(sandbox, 'ghost-posts.json'), 'utf8').catch(() => '[]')), [], 'unapplied candidate cannot publish automatically');
                await writer.frame.locator('#apply-candidate-btn').click();
            }
            await until(async () => (await writer.frame.locator('#article-preview').innerText()).includes('서버 경로에서 수정한 의도'), 'server respects edited intent');
            if (!autoMode) {
                await until(async () => (await writingCounts.locator('.log-unread').count()) === 1, 'a newly generated background article has an unread marker');
                await sidebar.frame.getByText('solve.py', { exact: true }).click();
                await sidebar.frame.locator('#ctx-write-blog').click();
                await until(async () => (await writingCounts.locator('.log-unread').count()) === 0, 'viewing the newly generated article clears its marker');
            }
            if (autoMode) {
                await until(async () => (await writer.frame.locator('#ghost-status').innerText()).includes('최신 내용 저장됨'), 'generated article uploads automatically without a save or publish click');
                const posts = JSON.parse(await fs.readFile(path.join(sandbox, 'ghost-posts.json'), 'utf8'));
                assert.equal(posts.length, 1); assert.equal(posts[0].status, autoMode === 'publish' ? 'published' : 'draft');
                assert.deepEqual(posts[0].tags.map(tag => tag.name), ['PS', 'segment tree', '알고리즘']);
                assert.match(posts[0].lexical, /서버 경로에서 수정한 의도/);
            } else {
                assert.deepEqual(JSON.parse(await fs.readFile(path.join(sandbox, 'ghost-posts.json'), 'utf8').catch(() => '[]')), [], 'disabled automatic upload keeps completed articles local');
            }
            await writer.frame.locator('#source-btn').click();
            await writer.frame.locator('#article-title').fill('에디터에서 고친 제목');
            await writer.frame.locator('#article-body').fill('## 재시작\n\n서버와 무관하게 보존된 로컬 본문');
            await until(async () => (await writer.frame.locator('#save-status').innerText()) === '저장됨', 'draft persisted');
        }
        await until(async () => (await writer.frame.locator('#article-body').inputValue()).includes('서버와 무관하게 보존된 로컬 본문'), 'local draft restored');
        await until(async () => (await writingCounts.innerText()).includes('글 1'), 'saved article count survives reopening');
        if ((await writer.frame.locator('#source-btn').getAttribute('aria-pressed')) === 'true') await writer.frame.locator('#source-btn').click();
        assert.equal(await writer.frame.locator('#article-title').inputValue(), '에디터에서 고친 제목');
        assert.equal(await writer.frame.locator('.prose-editor > hr').count(), 0);
        assert.equal(await writer.frame.locator('#current-article .article-title-divider').count(), 1);
        await checkGhostExport(writer, sandbox, stage);
        assert.equal((await requests()).length, stage === 'first' ? 2 : 3, 'reopening must not repeat model work');
        if (stage === 'first') {
            await vscode.commands.executeCommand('psb.sidebar.focus');
            await sidebar.frame.getByText('solve.py', { exact: true }).click({ button: 'right' });
            await sidebar.frame.locator('#ctx-view-history').click();
            const reviewed = await surface(browser, '#write-btn');
            await until(async () => (await reviewed.frame.locator('#preparation-status').innerText()).includes('끝났어요'), 'review reuses the same history');
            assert.equal((await requests()).length, 2);
            await reviewed.frame.locator('#write-btn').click();
            await vscode.commands.executeCommand('psb.sample');
            await until(async () => {
                for (const context of browser.contexts()) for (const page of context.pages()) for (const frame of page.frames()) {
                    if (await frame.locator('#file-name').count() && (await frame.locator('#file-name').innerText()).includes('샘플-중복제거') && !(await frame.locator('#generate-btn').isDisabled())) return true;
                }
                return false;
            }, 'sample history prepares without editing workspace files');
            await vscode.commands.executeCommand('psb.sample');
            assert.equal((await requests()).length, 3, 'sample reopening reuses its plan');
            assert.ok((await requests())[2].source.fileName.includes('샘플'));
        }
        await vscode.commands.executeCommand('psb.sidebar.focus');
        const usageSidebar = await surface(browser, '#usage-btn');
        // Headless Linux hosts can restart without an OS keyring. An unsigned
        // session must hide usage; explicitly connect before comparing amounts.
        if ((await usageSidebar.frame.locator('#connect-server-btn').innerText()) === '로그인') {
            assert.equal(await usageSidebar.frame.locator('#usage-btn').isHidden(), true);
            await usageSidebar.frame.locator('#connect-server-btn').click();
        }
        const credentials = await (await fetch(process.env.PSB_API_URL + '/auth/local', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'})).json();
        const usageResponse = await fetch(process.env.PSB_API_URL + '/usage', {headers: {Authorization: 'Bearer ' + credentials.token}});
        assert.equal(usageResponse.status, 200);
        const usage = await usageResponse.json();
        try {
            await until(async () => (await usageSidebar.frame.locator('#usage-btn').getAttribute('title'))?.includes(`오늘 요청 ${usage.todayRequests}회`), 'sidebar reflects actual server accounting after generation and restart');
        } catch (error) {
            await fs.writeFile(path.join(sandbox, stage + '-usage-error.json'), JSON.stringify({
                expected: usage,
                label: await usageSidebar.frame.locator('#usage-btn').innerText(),
                detail: await usageSidebar.frame.locator('#usage-btn').getAttribute('title'),
                account: await usageSidebar.frame.locator('#connect-server-btn').innerText(),
            }));
            await usageSidebar.page.screenshot({path: path.join(sandbox, stage + '-usage-error.png')});
            throw error;
        }
        const label = await usageSidebar.frame.locator('#usage-btn').innerText();
        const credits = value => new Intl.NumberFormat('ko-KR', {maximumFractionDigits: 0}).format(Math.floor(value));
        assert.ok(label.includes(credits(usage.freeHourlyUsedCredits)));
        assert.ok(label.includes(credits(usage.freeHourlyLimitCredits)));
        assert.ok(label.includes('유료 ' + credits(usage.creditBalance) + ' 크레딧'));
        assert.doesNotMatch(label, /USD|\$|달러/);
        await writer.page.screenshot({ path: path.join(sandbox, stage + '.png') });
        await fs.writeFile(path.join(sandbox, stage + '.json'), JSON.stringify({ stage, passed: true }));
    } finally { restoreFetch(); await browser.close(); }
};
