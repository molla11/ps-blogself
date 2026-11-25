import { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const read = (file: string) => readFileSync(file, 'utf8');
const { buildWebview } = require('../../scripts/build-webview.cjs');
const bundles = new Map<string, Promise<string>>();
export async function openWebview(page: Page, view: boolean | 'settings' | 'welcome' | 'history' = false, saved: any = {}) {
    const sidebar = view === true;
    const root = typeof view === 'string' ? {
        welcome: 'src/welcome/templates/welcome', settings: 'src/settings/templates/settings', history: 'src/services/templates/history',
    }[view] : sidebar ? 'src/sidebar/templates/sidebar' : 'src/services/templates/blogPostMain';
    const nonce = 'test-nonce';
    const bridge = `window.__messages=[];window.__saved=${JSON.stringify(saved)};window.acquireVsCodeApi=()=>({postMessage:m=>window.__messages.push(m),getState:()=>window.__saved,setState:s=>window.__saved=s});`;
    let html = read(root + '.html').replace(
        '{{csp}}',
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src https: data:;`,
    );
    const css = `<style nonce="${nonce}">${read(root + '.css')}</style>`;
    const entry = root + 'Scripts.webview.js';
    if (!bundles.has(entry)) bundles.set(entry, buildWebview(entry).then((result: any) => result.outputFiles[0].text));
    const js = `<script nonce="${nonce}">${bridge}\n${await bundles.get(entry)}</script>`;
    if (view === 'history') {
        html = html.replaceAll('{{total}}', String(saved.total ?? 354))
            .replace('{{recorded}}', String(saved.recorded ?? true)).replace('{{loadId}}', 'test-load').replace('{{version}}', 'test-version');
    }
    html = html
        .replace('{{logoUri}}', () => 'data:image/png;base64,' + readFileSync('media/image/logo_ps_blogself1.png').toString('base64'))
        .replace(/<link[^>]*>/g, '')
        .replace(sidebar ? '<!-- {{css}} -->' : '{{styles}}', () => css)
        .replace(sidebar ? '{{js}}' : '{{script}}', () => js);
    await page.setContent(html);
}
