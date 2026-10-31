import { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const read = (file: string) => readFileSync(file, 'utf8');
const { buildWebview } = require('../../scripts/build-webview.cjs');
const bundles = new Map<string, Promise<string>>();
export async function openWebview(page: Page, sidebar: boolean | 'settings' | 'welcome' = false, saved: any = {}) {
    const settings = sidebar === 'settings';
    const root = sidebar === 'welcome' ? 'src/welcome/templates/welcome' : settings ? 'src/settings/templates/settings' : sidebar ? 'src/sidebar/templates/sidebar' : 'src/services/templates/blogPostMain';
    sidebar = sidebar === true;
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
    html = html
        .replace(/<link[^>]*>/g, '')
        .replace(sidebar ? '<!-- {{css}} -->' : '{{styles}}', () => css)
        .replace(sidebar ? '{{js}}' : '{{script}}', () => js);
    await page.setContent(html);
}
