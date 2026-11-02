import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { articleHtml, taggedMarkdown } from '../writing/ArticleExport';
import { normalizeExportTags } from '../settings/ExportTags';
import { ShikiService } from '../services/ShikiService';
import { separateArticleTitle } from '../writing/ArticleContent';
import { documentFromMarkdown, documentHtml, documentMarkdown, ghostDocument } from '../writing/ArticleDocument';

test('comma-separated export tags keep multiword names and ignore empty or repeated entries', () => {
    assert.deepEqual(normalizeExportTags(' 알고리즘, PS, segment tree, , ps, 알고리즘, '), ['알고리즘', 'PS', 'segment tree']);
    assert.deepEqual(normalizeExportTags(' , , '), []);
    assert.deepEqual(normalizeExportTags(['é', 'e\u0301']), ['é']);
    for (const value of [null, [5], ['tag,other'], 'line\nbreak', 'x'.repeat(192), Array.from({ length: 51 }, (_, i) => 'tag' + i)]) assert.throws(() => normalizeExportTags(value), /태그/);
});

test('export metadata escapes tags, preserves source, and disappears when tags are empty', () => {
    const source = '# 제목\n\n---\n\n```c\nint a = 10;\n```\n';
    const tags = ['알고리즘', 'segment tree', '"/><script>alert(1)</script>', 'true', 'a: b', 'C:\\PS'];
    const markdown = taggedMarkdown(source, tags);
    assert.equal(markdown.slice(markdown.indexOf('\n---\n\n') + 6), source);
    assert.deepEqual(JSON.parse(markdown.split('\n')[1].slice('tags: '.length)), tags);
    assert.equal(taggedMarkdown(source, []), source);
    const html = articleHtml('제목', source, undefined, tags);
    assert.match(html, /<meta name="keywords" content="알고리즘, segment tree,/);
    assert.match(html, /&quot;\/&gt;&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(articleHtml('제목', source), /name="keywords"/);
});

test('separate titles and display dividers never enter the body document', () => {
    const article = { title: '제목 <script>', markdown: '## 본문 제목\n\n````py\nprint("```")\n````\n' };
    assert.equal(separateArticleTitle(article), article);
    const doc = documentFromMarkdown(article.markdown);
    const html = articleHtml(article.title, article.markdown, documentHtml(doc));
    assert.equal((html.match(/<h1>/g) || []).length, 1);
    assert.doesNotMatch(html, /<hr>|<script>/);
    const ghost = ghostDocument(doc);
    assert.equal(ghost.root.children![0].tag, 'h2');
    assert.equal(ghost.root.children!.some(node => node.type === 'horizontalrule'), false);
});

test('previous integrated drafts lose only their title and leading display divider', () => {
    const body = '## 본문\r\n\r\n````py\r\nprint("```")\r\n````\r\n\r\n---\r\n\r\n마지막\r\n';
    const old = { title: '제목', markdown: '---\r\n\r\n' + body,
        document: { ...documentFromMarkdown('# 제목\n\n---\n\n' + body), titleInDocument: true as const } };
    const separated = separateArticleTitle(old);
    assert.equal(separated.title, '제목');
    assert.equal(separated.markdown, body);
    assert.equal(separated.document.titleInDocument, undefined);
    assert.equal(separated.document.root.children![0].tag, 'h2');
    assert.equal(separated.document.root.children!.filter(node => node.type === 'article-divider').length, 1);
    assert.equal(separateArticleTitle(separated), separated);
    assert.equal(old.document.root.children![0].tag, 'h1');
    const ordinary = { title: '별도 제목', markdown: '# 본문 H1\n\n---\n\n본문', document: documentFromMarkdown('# 본문 H1\n\n---\n\n본문') };
    assert.equal(separateArticleTitle(ordinary), ordinary);
    assert.equal(documentMarkdown(ordinary.document), ordinary.markdown);
});

test('standalone HTML includes title and formatted Markdown while treating executable markup as text', () => {
    const html = articleHtml('<script>title</script>', '### 제목\n\n**강조**와 [링크](https://example.com)\n\n3. 셋째\n\n| 방법 | 비용 |\n| --- | --- |\n| 집합 | O(1) |\n\n```python\nprint("<script>")\n```\n\n<script>alert(1)</script>');
    assert.ok(html.startsWith('<!doctype html>'));
    assert.match(html, /<title>&lt;script&gt;title&lt;\/script&gt;<\/title>/);
    assert.match(html, /<h3>제목<\/h3>/); assert.match(html, /<strong>강조<\/strong>/);
    assert.match(html, /<ol start="3">/); assert.match(html, /<table>/);
    assert.match(html, /language-python/); assert.match(html, /img\{max-width:100%/);
    assert.doesNotMatch(html, /<script>/); assert.match(html, /default-src 'none'/);
});

test('unsupported history languages escape source markup in the highlighting fallback', async () => {
    const source = '<style>body{display:none}</style><button class="delete-btn">삭제</button>';
    const html = await ShikiService.getInstance().highlight(source, 'unsupported-history-language');
    assert.doesNotMatch(html, /<style>|<button/);
    assert.match(html, /&lt;style&gt;/);
    assert.match(html, /&lt;button class=&quot;delete-btn&quot;&gt;/);
});
