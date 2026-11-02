import MarkdownIt = require('markdown-it');
import { normalizeExportTags } from '../settings/ExportTags';

export function taggedMarkdown(markdown: string, tags: string[] = []): string {
    const names = normalizeExportTags(tags);
    return names.length ? `---\ntags: ${JSON.stringify(names)}\n---\n\n${markdown}` : markdown;
}

export function articleHtml(title: string, markdown: string, bodyHtml?: string, tags: string[] = []): string {
    const renderer = new MarkdownIt({ html: false });
    const heading = renderer.utils.escapeHtml(title || '풀이 기록');
    const names = normalizeExportTags(tags);
    const keywords = names.length ? `<meta name="keywords" content="${renderer.utils.escapeHtml(names.join(', '))}">\n` : '';
    return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:;">
${keywords}<title>${heading}</title><style>
body{max-width:760px;margin:48px auto;padding:0 24px;font:16px/1.9 system-ui,sans-serif;color:#24342c;background:#fff;overflow-wrap:anywhere}
h1{font-size:30px;line-height:1.4;margin-bottom:32px}h2,h3{line-height:1.5;margin-top:1.7em}pre{padding:18px;background:#f0f3f1;overflow:auto;border-radius:4px;font:13px/1.7 monospace}code{font-family:monospace}img{max-width:100%;height:auto}blockquote{margin-left:0;padding-left:18px;border-left:3px solid #dce2dd;color:#69756f}a{color:#35644e}table{width:100%;border-collapse:collapse}td,th{padding:8px 12px;border:1px solid #dce2dd;text-align:left}th{background:#f4f6f4}@media print{body{margin:0;max-width:none}pre{white-space:pre-wrap}}
</style></head><body><article><h1>${heading}</h1>${bodyHtml ?? renderer.render(markdown)}</article></body></html>`;
}
