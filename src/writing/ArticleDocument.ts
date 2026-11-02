import MarkdownIt = require('markdown-it');

/** Versioned, portable Lexical state. No selection, runtime node keys or credentials. */
export interface ArticleNode {
    type: string;
    version: number;
    children?: ArticleNode[];
    [key: string]: any;
}
export interface ArticleDocument { version: 1; root: ArticleNode; titleInDocument?: true }
const markdown = new MarkdownIt({ html: false });
const element = (type: string, children: ArticleNode[] = [], extra = {}): ArticleNode =>
    ({ type, version: 1, children, direction: null, format: '', indent: 0, ...extra });
const text = (value: string, format = 0): ArticleNode =>
    ({ type: 'text', version: 1, text: value, format, detail: 0, mode: 'normal', style: '' });
const paragraph = (children: ArticleNode[] = []) => element('paragraph', children, { textFormat: 0, textStyle: '' });

export function safeArticleUrl(value: string, image = false): string {
    if (image && /^psb-image:[a-f0-9]{64}$/.test(value)) return value;
    try {
        const url = new URL(value);
        if (!(image ? (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? ['http:'] : ['https:']) : ['https:', 'http:', 'mailto:']).includes(url.protocol) || url.username || url.password) return '';
        return url.href;
    } catch { return ''; }
}

/** CommonMark/GFM parsing comes from markdown-it; the mapping only defines our node vocabulary. */
export function documentFromMarkdown(source: string): ArticleDocument {
    const inline = (tokens: any[]): ArticleNode[] => {
        const root: ArticleNode[] = [], stack = [root];
        let marks = 0;
        const bits: Record<string, number> = { strong: 1, em: 2, s: 4 };
        for (const token of tokens || []) {
            const output = stack[stack.length - 1];
            const mark = /^(strong|em|s)_(open|close)$/.exec(token.type);
            if (mark) { marks = mark[2] === 'open' ? marks | bits[mark[1]] : marks & ~bits[mark[1]]; continue; }
            if (token.type === 'link_open') {
                const link = element('link', [], { url: safeArticleUrl(token.attrGet('href') || ''), rel: null, target: null, title: token.attrGet('title') || null });
                output.push(link); stack.push(link.children!);
            } else if (token.type === 'link_close') stack.pop();
            else if (token.type === 'image') output.push({ type: 'article-image', version: 1, src: safeArticleUrl(token.attrGet('src') || '', true) || token.attrGet('src') || '', alt: token.content, caption: token.attrGet('title') || '' });
            else if (token.type === 'hardbreak') output.push({ type: 'linebreak', version: 1 });
            else output.push(text(token.type === 'softbreak' ? '\n' : token.content || '', marks | (token.type === 'code_inline' ? 16 : 0)));
        }
        return root;
    };
    const root = element('root'), stack = [root];
    for (const token of markdown.parse(source, {})) {
        const parent = stack[stack.length - 1];
        const push = (node: ArticleNode, nested = false) => { parent.children!.push(node); if (nested) stack.push(node); };
        if (token.type === 'inline') parent.children!.push(...inline(token.children || []));
        else if (token.type === 'fence' || token.type === 'code_block') push(element('code', [text(token.content.replace(/\n$/, ''))], { language: token.info.trim().split(/\s/)[0] || '' }));
        else if (token.type === 'hr') push({ type: 'article-divider', version: 1 });
        else if (['thead_open', 'thead_close', 'tbody_open', 'tbody_close'].includes(token.type)) continue;
        else if (token.nesting === -1) stack.pop();
        else if (token.nesting === 1) {
            switch (token.type) {
                case 'paragraph_open': push(paragraph(), true); break;
                case 'heading_open': push(element('heading', [], { tag: token.tag }), true); break;
                case 'blockquote_open': push(element('quote'), true); break;
                case 'bullet_list_open': push(element('list', [], { listType: 'bullet', tag: 'ul', start: 1 }), true); break;
                case 'ordered_list_open': push(element('list', [], { listType: 'number', tag: 'ol', start: Number(token.attrGet('start') || 1) }), true); break;
                case 'list_item_open': push(element('listitem', [], { value: (parent.start || 1) + parent.children!.length }), true); break;
                case 'table_open': push(element('table'), true); break;
                case 'tr_open': push(element('tablerow'), true); break;
                case 'th_open': case 'td_open': push(element('tablecell', [], { headerState: token.type === 'th_open' ? 1 : 0, colSpan: 1, rowSpan: 1, backgroundColor: null, format: token.attrGet('style')?.replace('text-align:', '') || '' }), true); break;
            }
        }
    }
    const tidy = (node: ArticleNode) => {
        node.children?.forEach(tidy);
        if (node.type === 'listitem' || node.type === 'quote') {
            node.children = node.children!.flatMap((child, index) => child.type === 'paragraph'
                ? [...(index ? [{ type: 'linebreak', version: 1 }] : []), ...child.children!] : [child]);
        }
        if (node.type === 'list' && node.listType === 'bullet') {
            const items = node.children!;
            if (items.every(item => item.children?.[0]?.type === 'text' && /^\[[ xX]\] /.test(item.children[0].text))) {
                node.listType = 'check';
                items.forEach(item => { item.checked = /^\[[xX]\]/.test(item.children![0].text); item.children![0].text = item.children![0].text.slice(4); });
            }
        }
        if (node.type === 'tablecell' && !node.children?.some(child => child.type === 'paragraph')) node.children = [paragraph(node.children)];
    };
    tidy(root);
    // A block image cannot live in a paragraph: Ghost silently omits that shape.
    root.children = root.children!.flatMap(node => {
        if (node.type !== 'paragraph' || !node.children?.some(child => child.type === 'article-image')) return [node];
        const blocks: ArticleNode[] = []; let content: ArticleNode[] = [];
        for (const child of node.children) {
            if (child.type === 'article-image') { if (content.length) blocks.push(paragraph(content)); blocks.push(child); content = []; }
            else content.push(child);
        }
        if (content.length) blocks.push(paragraph(content));
        return blocks;
    });
    if (!root.children!.length) root.children!.push(paragraph());
    return { version: 1, root };
}

const types = new Set(['root', 'paragraph', 'heading', 'text', 'linebreak', 'tab', 'quote', 'list', 'listitem', 'link', 'autolink', 'code', 'code-highlight', 'table', 'tablerow', 'tablecell', 'article-image', 'article-divider']);
export function validateDocument(input: unknown): ArticleDocument {
    if (!input || typeof input !== 'object' || JSON.stringify(input).length > 1_200_000) throw new Error('글 문서가 너무 크거나 올바르지 않습니다.');
    const doc = input as ArticleDocument;
    if (doc.version !== 1 || doc.root?.type !== 'root') throw new Error('지원하지 않는 글 문서입니다.');
    let count = 0, length = 0;
    const visit = (node: ArticleNode, depth: number): ArticleNode => {
        if (!node || !types.has(node.type) || ++count > 20000 || depth > 48) throw new Error('지원하지 않는 글 블록입니다. 원문을 확인해 주세요.');
        const leaf = ['text', 'linebreak', 'tab', 'code-highlight', 'article-image', 'article-divider'].includes(node.type);
        if (node.type === 'root' && depth !== 0 || !leaf && !Array.isArray(node.children) || leaf && node.children !== undefined || ['text', 'code-highlight'].includes(node.type) && typeof node.text !== 'string') throw new Error('글 블록 구조가 올바르지 않습니다.');
        if (node.type === 'list' && !['bullet', 'number', 'check'].includes(node.listType)) throw new Error('목록 형식이 올바르지 않습니다.');
        if (node.mode !== undefined && !['normal', 'token', 'segmented'].includes(node.mode)) throw new Error('텍스트 형식이 올바르지 않습니다.');
        for (const key of ['indent', 'colSpan', 'rowSpan', 'headerState', 'textFormat', 'detail']) {
            if (node[key] !== undefined && (!Number.isInteger(node[key]) || node[key] < (key === 'colSpan' || key === 'rowSpan' ? 1 : 0))) throw new Error('글 블록 속성이 올바르지 않습니다.');
        }
        const output: ArticleNode = { type: node.type, version: 1 };
        for (const key of ['text', 'language', 'tag', 'listType', 'url', 'title', 'src', 'alt', 'caption', 'direction', 'mode', 'highlightType']) {
            if (typeof node[key] === 'string') { length += node[key].length; output[key] = node[key]; }
        }
        for (const key of ['format', 'indent', 'start', 'value', 'checked', 'detail', 'headerState', 'colSpan', 'rowSpan', 'textFormat']) {
            if (typeof node[key] === 'boolean' || typeof node[key] === 'number' && Number.isFinite(node[key]) || key === 'format' && typeof node[key] === 'string') output[key] = node[key];
        }
        if (length > 180000 || Number(output.indent || 0) > 32 || Number(output.colSpan || 1) > 100 || Number(output.rowSpan || 1) > 100) throw new Error('글 내용이나 중첩 범위가 너무 큽니다.');
        if (node.type === 'heading' && !/^h[1-6]$/.test(output.tag)) throw new Error('제목 수준이 올바르지 않습니다.');
        if (node.children !== undefined) {
            if (!Array.isArray(node.children)) throw new Error('글 블록 구조가 올바르지 않습니다.');
            output.children = node.children.map(child => visit(child, depth + 1));
        }
        return output;
    };
    return { version: 1, root: visit(doc.root, 0), ...(doc.titleInDocument === true ? { titleInDocument: true as const } : {}) };
}

export const documentText = (node: ArticleNode): string => node.type === 'linebreak' ? '\n' : node.type === 'tab' ? '\t' : node.text ?? (node.children || []).map(documentText).join('');
const escapeMd = (s: string) => s.replace(/[\\`*_[\]<>#~]/g, '\\$&');
export function documentMarkdown(doc: ArticleDocument): string {
    const inline = (node: ArticleNode): string => {
        if (node.type === 'linebreak') return '  \n';
        if (node.type === 'tab') return '\t';
        if (node.type === 'article-image') return image(node);
        if (node.type === 'link' || node.type === 'autolink') return `[${(node.children || []).map(inline).join('')}](${String(node.url || '').replace(/[()\s]/g, c => encodeURIComponent(c))})`;
        if (node.type !== 'text' && node.type !== 'code-highlight') return (node.children || []).map(inline).join('');
        const format = Number(node.format || 0), value = node.text || '';
        if (format & 16) { const fence = '`'.repeat(Math.max(1, ...[...value.matchAll(/`+/g)].map(m => m[0].length + 1))), pad = /`/.test(value) || /^ | $/.test(value) && !/^ +$/.test(value) ? ' ' : ''; return `${fence}${pad}${value}${pad}${fence}`; }
        const [, leading, middle, trailing] = /^(\s*)([\s\S]*?)(\s*)$/.exec(value)!;
        if (!middle) return value;
        let out = escapeMd(middle);
        if (format & 1) out = `**${out}**`;
        if (format & 2) out = `*${out}*`;
        if (format & 4) out = `~~${out}~~`;
        return leading + out + trailing;
    };
    const image = (node: ArticleNode) => `![${escapeMd(node.alt || '')}](${String(node.src || '').replace(/[()\s]/g, c => encodeURIComponent(c))}${node.caption ? ` "${String(node.caption).replace(/["\\]/g, '\\$&')}"` : ''})`;
    const block = (node: ArticleNode): string => {
        const children = node.children || [];
        switch (node.type) {
            case 'root': return children.map(block).join('\n\n');
            case 'heading': return '#'.repeat(Number(node.tag?.slice(1) || 2)) + ' ' + children.map(inline).join('');
            case 'code': { const code = documentText(node), fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(m => m[0].length + 1))); return `${fence}${node.language || ''}\n${code}\n${fence}`; }
            case 'quote': return children.map(child => ['code', 'list', 'quote', 'table', 'heading'].includes(child.type) ? '\n' + block(child) + '\n' : inline(child)).join('').replace(/^\n|\n$/g, '').split('\n').map(line => '> ' + line).join('\n');
            case 'list': return children.map((item, index) => {
                const prefix = node.listType === 'number' ? `${Number(node.start || 1) + index}. ` : node.listType === 'check' ? `- [${item.checked ? 'x' : ' '}] ` : '- ';
                const body = (item.children || []).map(child => ['list', 'code', 'quote', 'table', 'heading'].includes(child.type) ? '\n' + block(child) : child.type === 'paragraph' ? child.children!.map(inline).join('') : inline(child)).join('');
                return prefix + body.split('\n').map((line, i) => (i ? ' '.repeat(prefix.length) : '') + line).join('\n');
            }).join('\n');
            case 'table': return children.map((row, index) => {
                const cells = row.children || [], values = cells.map(cell => block(cell).replace(/\n/g, '<br>').replace(/\|/g, '\\|'));
                const line = `| ${values.join(' | ')} |`;
                return index === 0 ? line + '\n| ' + cells.map(cell => cell.format === 'center' ? ':---:' : cell.format === 'right' ? '---:' : '---').join(' | ') + ' |' : line;
            }).join('\n');
            case 'tablecell': return children.map(block).join('\n');
            case 'article-image': return image(node);
            case 'article-divider': return '---';
            default: return children.map(inline).join('').replace(/^( {0,3})([-+])(?=\s|[-+])/gm, '$1\\$2').replace(/^( {0,3}\d+)([.)])(?=\s)/gm, '$1\\$2').replace(/^( {0,3})=/gm, '$1\\=');
        }
    };
    return block(doc.root);
}

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
export function documentHtml(doc: ArticleDocument, imageSources: Record<string, string> = {}): string {
    const render = (node: ArticleNode): string => {
        const body = (node.children || []).map(render).join('');
        switch (node.type) {
            case 'root': return body;
            case 'text': case 'code-highlight': {
                let value = escapeHtml(node.text || ''); const format = Number(node.format || 0);
                if (format & 16) value = `<code>${value}</code>`;
                if (format & 1) value = `<strong>${value}</strong>`;
                if (format & 2) value = `<em>${value}</em>`;
                if (format & 4) value = `<s>${value}</s>`;
                return value;
            }
            case 'linebreak': return '<br>';
            case 'tab': return '\t';
            case 'heading': return `<${node.tag}>${body}</${node.tag}>`;
            case 'paragraph': return `<p>${body}</p>`;
            case 'quote': return `<blockquote>${body}</blockquote>`;
            case 'link': case 'autolink': { const url = safeArticleUrl(node.url || ''); return url ? `<a href="${escapeHtml(url)}">${body}</a>` : body; }
            case 'code': return `<pre><code class="language-${escapeHtml(node.language || '')}">${escapeHtml(documentText(node))}</code></pre>`;
            case 'list': return node.listType === 'number' ? `<ol start="${Number(node.start || 1)}">${body}</ol>` : `<ul>${body}</ul>`;
            case 'listitem': return `<li>${node.checked !== undefined ? (node.checked ? '☑ ' : '☐ ') : ''}${body}</li>`;
            case 'table': return `<table>${body}</table>`;
            case 'tablerow': return `<tr>${body}</tr>`;
            case 'tablecell': { const tag = node.headerState ? 'th' : 'td'; return `<${tag}${node.colSpan > 1 ? ` colspan="${node.colSpan}"` : ''}${node.rowSpan > 1 ? ` rowspan="${node.rowSpan}"` : ''}>${body}</${tag}>`; }
            case 'article-divider': return '<hr>';
            case 'article-image': { const src = imageSources[node.src] || safeArticleUrl(node.src || '', true); return `<figure>${src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(node.alt || '')}">` : ''}${node.caption ? `<figcaption>${escapeHtml(node.caption)}</figcaption>` : ''}</figure>`; }
            default: throw new Error('지원하지 않는 글 블록입니다.');
        }
    };
    return render(validateDocument(doc).root);
}

/** Ghost's node vocabulary is deliberately separate from the current Lexical runtime. */
export function ghostDocument(doc: ArticleDocument) {
    const hasImage = (node: ArticleNode): boolean => node.type === 'article-image' || !!node.children?.some(hasImage);
    const convert = (node: ArticleNode): ArticleNode => {
        if (node.type === 'list' && node.listType === 'check' || node.type === 'quote' && node.children?.some(child => ['code', 'list', 'table', 'quote'].includes(child.type)) || ['paragraph', 'heading', 'quote', 'list'].includes(node.type) && node.children?.some(hasImage)) return { type: 'html', version: 1, html: documentHtml({ version: 1, root: element('root', [node]) }) };
        const children = (node.children || []).map(convert);
        switch (node.type) {
            case 'code': return { type: 'codeblock', version: 1, code: documentText(node), language: node.language || '', caption: '' };
            case 'table': return { type: 'html', version: 1, html: documentHtml({ version: 1, root: element('root', [node]) }) };
            case 'article-image': {
                const src = safeArticleUrl(node.src || '', true);
                if (!src || src.startsWith('psb-image:')) throw new Error('이미지를 먼저 업로드해 주세요.');
                return { type: 'image', version: 1, src, alt: node.alt || '', caption: escapeHtml(node.caption || '') };
            }
            case 'article-divider': return { type: 'horizontalrule', version: 1 };
            case 'heading': return { ...node, type: 'extended-heading', children };
            case 'quote': return { ...node, type: 'extended-quote', children };
            case 'text': case 'code-highlight': return { ...text(node.text || '', Number(node.format || 0)), type: 'extended-text' };
            case 'tab': return { ...text('\t'), type: 'extended-text' };
            case 'link': case 'autolink': return { ...node, type: 'link', url: safeArticleUrl(node.url || ''), children };
            case 'root': case 'paragraph': case 'list': case 'listitem': return { ...node, children };
            case 'linebreak': return { type: 'linebreak', version: 1 };
            // Table internals are rendered by the parent table fallback.
            case 'tablerow': case 'tablecell': return { ...node, children };
            default: throw new Error('Ghost에서 지원하지 않는 블록입니다.');
        }
    };
    return { root: convert(validateDocument(doc).root) };
}
