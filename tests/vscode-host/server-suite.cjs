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
async function surface(browser, selector, previousFrames) {
    return until(async () => {
        for (const context of browser.contexts())
            for (const page of context.pages())
                for (const frame of page.frames()) {
                    try {
                        if (!previousFrames?.has(frame) && await frame.locator(selector).count()) return { page, frame };
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
            const folderFile = welcome.frame.locator('.file-link').filter({ hasText: 'solve.py' });
            await folderFile.waitFor();
            await until(() => welcome.frame.locator('.brand-icon').evaluate(img => img.naturalWidth > 0), 'extension logo loaded');
            const initialFile = path.join(sandbox, 'workspace', 'solve.py');
            const diskTime = (await fs.stat(initialFile)).mtime.toISOString();
            assert.equal(await folderFile.locator('time').getAttribute('datetime'), diskTime);
            const folderButton = welcome.frame.getByRole('button', { name: '다른 폴더 열기', exact: true });
            await fs.rename(initialFile, initialFile + '.txt');
            await folderButton.click();
            const picker = welcome.page.locator('.quick-input-widget input:visible');
            await picker.waitFor();
            await picker.press('Escape');
            await until(() => folderButton.isEnabled(), 'folder picker can be cancelled');
            await vscode.commands.executeCommand('psb.sidebar.focus');
            const { frame: emptySidebar } = await surface(browser, '#open-code-folder');
            await emptySidebar.getByRole('button', { name: '폴더를 열면 코드 수정을 자동으로 기록합니다.' }).click();
            await picker.waitFor();
            await picker.press('Escape');
            await vscode.commands.executeCommand('psb.welcome');
            const createdFile = path.join(sandbox, 'workspace', 'onboarding.cpp');
            await welcome.frame.getByRole('button', { name: '코드 파일 만들기' }).click();
            await picker.waitFor();
            await picker.fill(createdFile);
            await picker.press('Enter');
            await until(() => vscode.window.activeTextEditor?.document.uri.fsPath === createdFile, 'new file opens for editing');
            assert.equal(await fs.readFile(createdFile, 'utf8'), '');
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await fs.unlink(createdFile);
            await vscode.commands.executeCommand('psb.welcome');
            await fs.rename(initialFile + '.txt', initialFile);
            await folderFile.waitFor();
            assert.ok(await folderButton.isHidden());
            const nested = path.join(sandbox, 'workspace', 'problems', 'search.CPP');
            await fs.mkdir(path.dirname(nested), { recursive: true });
            await fs.writeFile(nested, '');
            await welcome.frame.locator('.file-link').filter({ hasText: 'search.CPP' }).waitFor();
            await welcome.frame.getByRole('button', { name: '코드 목록 열기' }).click();
            await picker.waitFor();
            await picker.fill('search.CPP');
            await picker.press('Enter');
            await until(() => vscode.window.activeTextEditor?.document.uri.fsPath === nested, 'selected code opens from the list');
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            const external = path.join(sandbox, 'outside.c');
            await fs.writeFile(external, 'int main() {}');
            await vscode.window.showTextDocument(vscode.Uri.file(external), { preview: false });
            await vscode.commands.executeCommand('psb.welcome');
            const externalFile = welcome.frame.locator('.file-link').filter({ hasText: 'outside.c' });
            await externalFile.waitFor();
            assert.equal(await externalFile.locator('time').getAttribute('datetime'), (await fs.stat(external)).mtime.toISOString());
            const scratch = path.join(sandbox, 'scratch.c');
            await fs.writeFile(scratch, 'int main() {}');
            const earlier = new Date(Date.now() - 60_000);
            await fs.utimes(scratch, earlier, earlier);
            const scratchEditor = await vscode.window.showTextDocument(vscode.Uri.file(scratch), { preview: false });
            await scratchEditor.edit(edit => edit.insert(new vscode.Position(0, 0), '// 저장 전 변경\n'));
            await vscode.commands.executeCommand('psb.welcome');
            assert.equal(await welcome.frame.locator('.file-name').first().innerText(), 'outside.c', 'switching tabs preserves modification order');
            const latest = new Date(Date.now() + 1000);
            await fs.utimes(nested, latest, latest);
            await until(async () => (await welcome.frame.locator('.file-name').first().innerText()) === 'search.CPP', 'disk edits reorder Welcome');
            await welcome.frame.getByRole('button', { name: 'search.CPP 글쓰기' }).click();
            const unrecordedTools = (await surface(browser, '#writer-tools')).frame;
            const unrecordedWriter = (await surface(browser, '#prepare-empty-btn')).frame;
            await unrecordedTools.getByRole('button', { name: '메모 생성', exact: true }).waitFor();
            assert.equal(await unrecordedTools.locator('#writer-file-name').innerText(), 'search.CPP');
            assert.ok(await unrecordedWriter.locator('#prepare-empty-btn').isHidden());
            const toggle = unrecordedTools.locator('#library-toggle');
            const roomy = await unrecordedTools.evaluate(() => innerHeight >= 600);
            assert.equal(await toggle.getAttribute('aria-expanded'), String(roomy));
            if (!roomy) await toggle.click();
            await unrecordedTools.locator('.log-item').filter({ hasText: 'search.CPP' }).click();
            await unrecordedTools.locator('#ctx-view-history').click();
            const emptyHistory = (await surface(browser, '.history-entry')).frame;
            await unrecordedTools.locator('#main-view.history #library-toggle').waitFor();
            assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
            assert.equal(await emptyHistory.locator('.history-entry').count(), 1);
            assert.equal(await emptyHistory.locator('.stat-added').innerText(), '+0(0)');
            assert.equal(await emptyHistory.locator('.diff-line').count(), 0);
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            const emptyWriterTab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.label.includes('글 만들기') && tab.label.includes('search.CPP'));
            assert.ok(emptyWriterTab);
            await vscode.window.tabGroups.close(emptyWriterTab);
            await vscode.commands.executeCommand('psb.welcome');
            assert.equal((await requests()).length, 0, 'opening an unrecorded file for writing waits for explicit memo generation');
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
            await vscode.commands.executeCommand('psb.sidebar.focus');
            const files = (await surface(browser, '#generate-blog-btn')).frame;
            const candidate = files.locator('.log-item').filter({ hasText: 'solve.py' });
            await candidate.click();
            assert.equal(await candidate.locator('time').getAttribute('datetime'), diskTime);
            assert.ok(await files.locator('#generate-blog-btn').isEnabled());
            await files.locator('#ctx-view-history').click();
            const preview = (await surface(browser, '.history-entry')).frame;
            const savedCode = await fs.readFile(initialFile, 'utf8');
            assert.equal(await preview.locator('h2').innerText(), '파일 수정 기록: solve.py');
            assert.equal(await preview.locator('.history-entry').count(), 1);
            assert.equal(await preview.locator('.stat-date').getAttribute('datetime'), diskTime);
            assert.equal(await preview.locator('.diff-line:not(.diff-added)').count(), 0);
            assert.equal((await preview.locator('.diff-added .diff-content').allTextContents()).join('\n'), savedCode);
            await preview.getByRole('button', { name: '이 시점의 코드 보기' }).click();
            await until(() => {
                const doc = vscode.window.activeTextEditor?.document;
                return doc?.isUntitled && doc.languageId === 'python' && doc.getText().endsWith('\n\n' + savedCode);
            }, 'snapshot opens with the displayed code');
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            const previewTab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.label === 'History: solve.py');
            assert.ok(previewTab);
            await vscode.window.tabGroups.close(previewTab);
            await vscode.commands.executeCommand('psb.sidebar.focus');
            await fs.unlink(nested);
            await until(async () => !(await files.locator('.log-item').filter({ hasText: 'search.CPP' }).count()), 'removed file leaves the list');
            await welcome.page.screenshot({ path: path.join(sandbox, 'welcome.png') });
        }
        await vscode.window.tabGroups.close(welcomeTabs());
        assert.deepEqual(vscode.workspace.getConfiguration('psb').get('exportTags'), ['PS', 'segment tree', '알고리즘'], 'export tags survive restart');
        await until(() => welcomeTabs().length === 0, 'welcome tab closes');
        if (stage === 'first') {
            const doc = await vscode.workspace.openTextDocument(path.join(sandbox, 'workspace/solve.py'));
            const editor = await vscode.window.showTextDocument(doc);
            for (const content of ['print(1 + 2)\n', 'total = 0\nfor value in [1, 2, 3]:\n    total += value\nprint(total)\n']) {
                await editor.edit(edit => edit.replace(new vscode.Range(0, 0, doc.lineCount, 0), content));
                await doc.save();
            }
        }
        await vscode.commands.executeCommand('psb.sidebar.focus');
        const sidebar = await surface(browser, '#generate-blog-btn');
        const recorded = sidebar.frame.locator('.log-item').filter({ has: sidebar.frame.getByText('solve.py', { exact: true }) });
        await until(async () => await recorded.count() === 1 && await recorded.getAttribute('data-source') === '', 'discovered file becomes one recorded row');
        const writingCounts = sidebar.frame.locator('.log-item').filter({ has: sidebar.frame.getByText('solve.py', { exact: true }) }).locator('.log-writing');
        if (stage === 'first') {
            assert.equal((await requests()).length, 0, 'a burst of saves has no immediate AI request');
            await recorded.click({ button: 'right' });
            await until(async () => (await writingCounts.innerText()).includes('메모 1'), 'file menu prepares memos before entering history');
            assert.equal((await requests()).length, 1, 'related saves are prepared in one background job');
            if (!(await sidebar.frame.locator('#ctx-view-history').isVisible())) await recorded.click({ button: 'right' });
            await sidebar.frame.locator('#ctx-view-history').click();
            const history = await surface(browser, '#write-btn:visible');
            await until(async () => (await history.frame.locator('#preparation-status').innerText()).includes('끝났어요'), 'history prepares AI automatically');
            await until(async () => (await writingCounts.innerText()).includes('메모 1'), 'prepared note bundle appears on its file row');
            assert.equal(await writingCounts.locator('.log-unread').count(), 0, 'prepared notes never show unread notifications');
            assert.equal((await requests()).length, 1);
            await history.frame.locator('#write-btn').click();
        } else {
            await recorded.click();
            await sidebar.frame.locator('#generate-blog-btn').click();
        }
        const writer = await surface(browser, '#generate-btn');
        await until(async () => !(await writer.frame.locator('#generate-btn').isDisabled()), 'prepared plan reused');
        if (stage === 'first') {
            assert.equal(await writingCounts.locator('.log-unread').count(), 0, 'opening notes does not create an article notification');
            assert.equal(await writer.frame.locator('#summary').inputValue(), 'AI가 미리 정리한 설명');
            assert.equal((await requests()).length, 1, 'opening writer must reuse preparation');
            await writer.frame.locator('#summary').fill('서버 경로에서 수정한 의도');
            const controls = sidebar.frame.locator('#writer-tools');
            await controls.getByRole('button', { name: '글쓰기', exact: true }).waitFor();
            assert.ok(await writer.frame.locator('#generate-btn').isHidden());
            await controls.locator('#side-style').selectOption('formal');
            await until(async () => (await writer.frame.locator('#writing-style').inputValue()) === 'formal', 'sidebar settings apply to the active draft');
            await controls.locator('#side-model').selectOption('standard');
            await until(async () => (await writer.frame.locator('#writing-model-value').innerText()) === 'standard', 'sidebar model selection reaches the editor');
            await controls.getByRole('button', { name: '글쓰기', exact: true }).click();
            const streaming = writer.frame.locator('.prose-editor[contenteditable=false]');
            await streaming.locator('h2', { hasText: '접근' }).waitFor();
            assert.ok((await streaming.innerText()).includes('생성 중인 본문'));
            await controls.getByRole('button', { name: '글 작성 취소', exact: true }).waitFor();
            assert.equal(await controls.locator('#side-progress-box').count(), 0);
            await writer.page.screenshot({ path: path.join(sandbox, 'streaming.png') });
            if (!autoMode) await vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
            if (autoMode === 'publish') {
                await controls.getByRole('button', { name: '변경사항 요약' }).click();
                await writer.frame.locator('#summary').fill('생성 중 수정한 풀이 의도');
                await until(async () => (await controls.locator('#side-save-status').innerText()) === '저장됨', 'concurrent edits saved before generation finishes');
                await controls.locator('#side-candidate-box').waitFor();
                assert.deepEqual(JSON.parse(await fs.readFile(path.join(sandbox, 'ghost-posts.json'), 'utf8').catch(() => '[]')), [], 'unapplied candidate cannot publish automatically');
                await controls.getByRole('button', { name: '새 결과 적용' }).click();
            }
            await until(async () => (await writer.frame.locator('#rich-editor').textContent()).includes('서버 경로에서 수정한 의도'), 'server respects edited intent');
            if (!autoMode) {
                await until(async () => (await writingCounts.locator('.log-unread').count()) === 1, 'a newly generated background article has an unread marker');
                await writer.page.bringToFront();
                await recorded.click();
                await sidebar.frame.locator('#ctx-write-blog').click();
                await writer.frame.locator('#article-view').waitFor();
                await writer.frame.locator('#article-title').click();
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
            const planTab = sidebar.frame.locator('[data-writer-action=plan]');
            const articleTab = sidebar.frame.locator('[data-writer-action=article]');
            await planTab.click();
            await writer.frame.locator('#plan-view').waitFor();
            await sidebar.frame.locator('#side-style').waitFor();
            await writer.page.screenshot({ path: path.join(sandbox, 'writer-plan.png') });
            await articleTab.click();
            await writer.frame.locator('#article-view').waitFor();
            assert.ok(await writer.frame.locator('#writing-header').isHidden());
            assert.ok(await writer.frame.locator('#article-toolbar').isHidden());
            await writer.frame.locator('#format-bar').waitFor();
            assert.ok(await controls.locator('#side-view-modes').isHidden());
            await vscode.commands.executeCommand('psb.openSettings');
            const advanced = (await surface(browser, '#advanced-writing-views')).frame;
            await advanced.getByText('고급', { exact: true }).click();
            const showViews = advanced.getByLabel('글쓰기에서 Markdown·미리보기 표시');
            assert.equal(await showViews.isChecked(), false);
            await showViews.check();
            await until(() => vscode.workspace.getConfiguration('psb').get('showAdvancedWritingViews') === true, 'advanced writing views saved');
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await sidebar.frame.locator('[data-writer-action=preview]').click();
            await writer.frame.locator('#article-preview').waitFor();
            await controls.getByRole('button', { name: '편집', exact: true }).click();
            await writer.frame.locator('#rich-editor').waitFor();
            await vscode.commands.executeCommand('workbench.action.closeSidebar');
            await writer.frame.getByRole('button', { name: '글쓰기 도구 열기' }).click();
            await controls.locator('#side-view-modes').waitFor();
            await writer.page.screenshot({ path: path.join(sandbox, 'writer-article.png') });
            await controls.getByRole('button', { name: 'Markdown', exact: true }).click();
            await writer.frame.locator('#article-title').fill('에디터에서 고친 제목');
            await writer.frame.locator('#article-body').fill('## 재시작\n\n서버와 무관하게 보존된 로컬 본문');
            await until(async () => (await controls.locator('#side-save-status').innerText()) === '저장됨', 'draft persisted');
            await until(async () => (await controls.locator('#side-sync-status').innerText()) === '서버 동기화됨', 'server confirmed the edited version');
            const api = process.env.PSB_API_URL;
            const { token } = await (await fetch(api + '/auth/local', { method: 'POST' })).json();
            const get = async route => {
                const response = await fetch(api + route, { headers: { Authorization: 'Bearer ' + token } });
                assert.equal(response.status, 200);
                return response.json();
            };
            await until(async () => {
                const job = (await get('/jobs')).items.find(item => item.kind === 'write_blog' && item.title === '에디터에서 고친 제목');
                if (!job) return false;
                const latest = (await get('/jobs/' + job.id + '/versions')).items[0];
                if (!latest) return false;
                const version = await get('/jobs/' + job.id + '/versions/' + latest.id);
                return version.title === '에디터에서 고친 제목' && version.markdown.includes('서버와 무관하게 보존된 로컬 본문');
            }, 'a saved editor change appears in the latest version of its server job');
        }
        await until(async () => (await writer.frame.locator('#article-body').inputValue()).includes('서버와 무관하게 보존된 로컬 본문'), 'local draft restored');
        await until(async () => (await writingCounts.innerText()).includes('글 1'), 'saved article count survives reopening');
        await sidebar.frame.locator('[data-writer-action=edit]').click();
        assert.equal(await writer.frame.locator('#article-title').inputValue(), '에디터에서 고친 제목');
        assert.equal(await writer.frame.locator('.prose-editor > hr').count(), 0);
        assert.equal(await writer.frame.locator('#current-article .article-title-divider').count(), 1);
        await checkGhostExport(writer, sidebar.frame, sandbox, stage);
        assert.equal((await requests()).length, stage === 'first' ? 2 : 3, 'reopening must not repeat model work');
        if (stage === 'first') {
            await vscode.commands.executeCommand('psb.sidebar.focus');
            const toggle = sidebar.frame.locator('#library-toggle');
            if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
            // The earlier history panel is retained while the new webview opens.
            const previousFrames = new Set(browser.contexts().flatMap(ctx => ctx.pages().flatMap(page => page.frames())));
            await recorded.click({ button: 'right' });
            await sidebar.frame.locator('#ctx-view-history').click();
            const reviewed = await surface(browser, '#write-btn:visible', previousFrames);
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
        const libraryToggle = usageSidebar.frame.locator('#library-toggle');
        if (await libraryToggle.isVisible() && await libraryToggle.getAttribute('aria-expanded') === 'false') await libraryToggle.click();
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
        if (stage === 'restart') {
            const filePath = path.join(sandbox, 'workspace', 'sequence.c');
            await fs.writeFile(filePath, 'int value = 1;\n');
            await vscode.commands.executeCommand('psb.welcome');
            const start = await surface(browser, '#welcome');
            await start.frame.getByRole('button', { name: 'sequence.c 글쓰기' }).click();
            const tools = sidebar.frame.locator('#writer-tools');
            const prepare = tools.getByRole('button', { name: '메모 생성', exact: true });
            await prepare.waitFor();
            assert.equal((await requests()).length, 3, 'opening the new file starts the writer without generating memos');
            await vscode.workspace.getConfiguration('psb').update('prepareOnReview', false, vscode.ConfigurationTarget.Workspace);
            const latest = 'int count(int n) {\n    int total = 0;\n    for (int i = 0; i < n; ++i) total += i;\n    return total;\n}\n';
            const doc = await vscode.workspace.openTextDocument(filePath);
            const editor = await vscode.window.showTextDocument(doc);
            await editor.edit(edit => edit.replace(new vscode.Range(0, 0, doc.lineCount, 0), latest));
            await doc.save();
            await vscode.commands.executeCommand('psb.welcome');
            await start.frame.getByRole('button', { name: 'sequence.c 글쓰기' }).click();
            await prepare.waitFor();
            await sleep(16000);
            assert.equal((await requests()).length, 3, 'manual mode keeps meaningful recorded edits local even after opening the writer');
            await prepare.click();
            await tools.getByRole('button', { name: '글쓰기', exact: true }).waitFor();
            const request = (await requests()).at(-1);
            assert.equal(request.source.fileName, 'sequence.c');
            assert.equal(request.source.finalCode, latest);
            const sequence = (await surface(browser, '#file-name:text-is("sequence.c")')).frame;
            await sequence.locator('#summary').fill('직접 확인한 반복문의 범위');
            await until(async () => (await tools.locator('#side-save-status').innerText()) === '저장됨', 'edited summary saved');
            const active = await vscode.window.showTextDocument(doc);
            const updated = latest.replace('i < n', 'i <= n');
            await active.edit(edit => edit.replace(new vscode.Range(0, 0, doc.lineCount, 0), updated));
            await doc.save();
            await vscode.workspace.getConfiguration('psb').update('prepareOnReview', true, vscode.ConfigurationTarget.Workspace);
            await vscode.commands.executeCommand('psb.welcome');
            await start.frame.getByRole('button', { name: 'sequence.c 글쓰기' }).click();
            await sequence.getByLabel('메모 #2 내용', { exact: true }).waitFor();
            assert.equal(await sequence.locator('#summary').inputValue(), '직접 확인한 반복문의 범위');
            const tail = (await requests()).at(-1);
            assert.equal(tail.priority, 'prefetch');
            assert.deepEqual(tail.source.changes.map(c => c.index), [1]);
            assert.equal(tail.source.initialCode, latest);
            assert.equal(tail.source.finalCode, updated);
        }
        await fs.writeFile(path.join(sandbox, stage + '.json'), JSON.stringify({ stage, passed: true }));
    } finally { restoreFetch(); await browser.close(); }
};
