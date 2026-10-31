const vscode = require('vscode');
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
async function checkGhostExport(writer, sandbox, stage) {
    const key = '123456789012345678901234:' + 'ab'.repeat(32);
    // Extension tests force VS Code application storage into memory, so re-enter the
    // fixture credential after restart; publication IDs and image cache remain real files.
    if (stage === 'first' || !(await writer.frame.locator('#ghost-status').innerText()).includes('ghost.psb.test')) {
        await writer.frame.locator('#export-menu-btn').click();
        await writer.frame.locator('#ghost-connect-btn').click();
        const input = writer.page.locator('.quick-input-widget input');
        await input.waitFor({ state: 'visible' }); await input.fill('https://ghost.psb.test'); await input.press('Enter');
        await until(async () => (await writer.page.locator('.quick-input-title').innerText()).includes('Admin API'), 'Ghost key prompt');
        await input.fill(key); await input.press('Enter');
        await until(async () => (await writer.frame.locator('#ghost-status').innerText()).includes('ghost.psb.test'), 'Ghost connected through SecretStorage');
    }
    if (stage === 'first') {
        const editor = writer.frame.getByRole('textbox', { name: '글 본문', exact: true });
        await editor.locator('p').last().click(); await writer.page.keyboard.press('End');
        await editor.evaluate(node => {
            const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
            const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'proof.png', { type: 'image/png' }));
            node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
        });
        await until(async () => await editor.locator('figure img').evaluate(img => img.naturalWidth === 1), 'private local image loads through the webview URI');
        await until(async () => (await writer.frame.locator('#save-status').innerText()) === '저장됨', 'local image document saved');
    }
    await writer.frame.locator('#export-menu-btn').click();
    await writer.frame.locator('#ghost-save-btn').click();
    try { await until(async () => (await writer.frame.locator('#ghost-status').innerText()).includes('최신 내용 저장됨'), 'Ghost saved current document'); }
    catch (error) { throw new Error(error.message + ': ' + await writer.frame.locator('#ghost-status').innerText() + '; ' + await writer.page.locator('.quick-input-title').allTextContents()); }
    let posts = JSON.parse(await fs.readFile(path.join(sandbox, 'ghost-posts.json'), 'utf8'));
    assert.equal(posts.length, 1); assert.equal(posts[0].status, stage === 'first' ? 'draft' : 'published');
    assert.match(posts[0].lexical, /서버와 무관하게 보존된 로컬 본문/);
    assert.match(posts[0].lexical, /https:\/\/ghost.psb.test\/content\/images\/test.png/);
    if (stage === 'first') {
        // VS Code deliberately refuses modal dialogs while extensionTestsPath is active.
        // Replace only this confirmation boundary; retain the complete webview/API/storage flow.
        const originalWarning = vscode.window.showWarningMessage;
        let confirmations = 0;
        vscode.window.showWarningMessage = async (message, options, ...actions) => {
            assert.match(message, /ghost.psb.test.*공개 게시/); assert.equal(options.modal, true); assert.deepEqual(actions, ['공개 게시']); confirmations++; return '공개 게시';
        };
        try {
            await writer.frame.locator('#export-menu-btn').click(); await writer.frame.locator('#ghost-publish-btn').click();
            await until(async () => (await writer.frame.locator('#ghost-status').innerText()).includes('게시됨'), 'explicit Ghost publishing');
            posts = JSON.parse(await fs.readFile(path.join(sandbox, 'ghost-posts.json'), 'utf8')); assert.equal(posts[0].status, 'published'); assert.equal(confirmations, 1);
        } finally { vscode.window.showWarningMessage = originalWarning; }
    }
    assert.ok(!(await writer.frame.content()).includes(key), 'Admin key must not enter the webview');
    await writer.page.screenshot({ path: path.join(sandbox, 'ghost-' + stage + '.png') });
}

exports.checkGhostExport = checkGhostExport;
exports.installGhostFixture = sandbox => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (String(url).startsWith('https://ghost.psb.test/ghost/api/admin/')) {
            assert.match(new Headers(init.headers).get('Authorization'), /^Ghost [^.]+\.[^.]+\.[^.]+$/);
            const file = path.join(sandbox, 'ghost-posts.json');
            const posts = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '[]'));
            if (!init.method || init.method === 'GET') return Response.json({ posts });
            if (String(url).includes('/images/upload/')) { assert.ok(init.body instanceof FormData); return Response.json({ images: [{ url: 'https://ghost.psb.test/content/images/test.png' }] }); }
            const data = JSON.parse(init.body).posts[0];
            if (init.method === 'POST') { assert.equal(posts.length, 0); posts.push({ ...data, id: '123456789012345678901234', updated_at: new Date().toISOString() }); }
            else { assert.equal(data.updated_at, posts[0].updated_at); Object.assign(posts[0], data, { updated_at: new Date().toISOString() }); }
            await fs.writeFile(file, JSON.stringify(posts)); return Response.json({ posts });
        }
        return originalFetch(url, init);
    };
    return () => { globalThis.fetch = originalFetch; };
};
