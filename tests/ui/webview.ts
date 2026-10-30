import { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const read = (file: string) => readFileSync(file, 'utf8');
export async function openWebview(page: Page, sidebar = false, saved: any = {}) {
    const root = sidebar ? 'src/sidebar/templates/sidebar' : 'src/services/templates/blogPostMain';
    const nonce = 'test-nonce';
    const bridge = `window.__messages=[];window.__saved=${JSON.stringify(saved)};window.acquireVsCodeApi=()=>({postMessage:m=>window.__messages.push(m),getState:()=>window.__saved,setState:s=>window.__saved=s});`;
    let html = read(root + '.html').replace(
        '{{csp}}',
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`,
    );
    const css = `<style nonce="${nonce}">${read(root + '.css')}</style>`;
    const js = `<script nonce="${nonce}">${bridge}\n${read(sidebar ? root + 'Scripts.webview.js' : 'src/services/templates/blogPostMainScripts.webview.js')}</script>`;
    html = html
        .replace(/<link[^>]*>/g, '')
        .replace(sidebar ? '<!-- {{css}} -->' : '{{styles}}', () => css)
        .replace(sidebar ? '{{js}}' : '{{script}}', () => js);
    await page.setContent(html);
}
