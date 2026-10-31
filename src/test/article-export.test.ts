import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { articleHtml } from '../writing/ArticleExport';

test('standalone HTML includes title and formatted Markdown while treating executable markup as text', () => {
    const html = articleHtml('<script>title</script>', '### 제목\n\n**강조**와 [링크](https://example.com)\n\n3. 셋째\n\n| 방법 | 비용 |\n| --- | --- |\n| 집합 | O(1) |\n\n```python\nprint("<script>")\n```\n\n<script>alert(1)</script>');
    assert.ok(html.startsWith('<!doctype html>'));
    assert.match(html, /<title>&lt;script&gt;title&lt;\/script&gt;<\/title>/);
    assert.match(html, /<h3>제목<\/h3>/); assert.match(html, /<strong>강조<\/strong>/);
    assert.match(html, /<ol start="3">/); assert.match(html, /<table>/);
    assert.match(html, /language-python/); assert.match(html, /img\{max-width:100%/);
    assert.doesNotMatch(html, /<script>/); assert.match(html, /default-src 'none'/);
});
