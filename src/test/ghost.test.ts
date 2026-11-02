import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArticleAssets, mapImages } from '../ghost/ArticleAssets';
import { GhostPublisher, articleHash } from '../ghost/GhostPublisher';
import { GhostClient, ghostToken, ghostUrl } from '../ghost/GhostClient';
import { documentFromMarkdown, documentHtml, documentMarkdown, ghostDocument, validateDocument } from '../writing/ArticleDocument';

const key = '123456789012345678901234:' + 'ab'.repeat(32);
const article = { title: '집합으로 조회하기', markdown: '## 접근\n\n**중복**을 제거한다.\n\n```python\n  print("```")\n```\n\n| 방법 | 시간 |\n| --- | --- |\n| 집합 | O(1) |' };
async function fixture(run: (ctx: any) => Promise<void>) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'psb-ghost-'));
    const ctx: any = { posts: [], creates: 0, updates: 0, uploads: 0, failCreate: false, delay: 0 };
    const server = createServer(async (req, res) => {
        const parts = req.headers.authorization?.replace('Ghost ', '').split('.') || [];
        assert.equal(parts[2], createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex')).update(parts.slice(0, 2).join('.')).digest('base64url'));
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); assert.equal(payload.aud, '/admin/'); assert.equal(payload.exp - payload.iat, 300);
        const url = new URL(req.url!, 'http://localhost');
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
        const reply = (value: any) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
        if (ctx.delay) await new Promise(resolve => setTimeout(resolve, ctx.delay));
        if (url.pathname.endsWith('/images/upload/')) { ctx.uploads++; assert.match(req.headers['content-type']!, /multipart\/form-data/); reply({ images: [{ url: 'https://cdn.example.com/' + ctx.uploads + '.png' }] }); return; }
        if (req.method === 'GET') { const id = /\/posts\/([^/]+)\//.exec(url.pathname)?.[1]; reply({ posts: id ? ctx.posts.filter((p: any) => p.id === id) : ctx.posts.filter((p: any) => !url.searchParams.get('filter') || 'slug:' + p.slug === url.searchParams.get('filter')) }); return; }
        const data = JSON.parse(Buffer.concat(chunks).toString()).posts[0];
        if (req.method === 'POST') {
            ctx.creates++; const post = { ...data, id: String(ctx.creates).padStart(24, '0'), updated_at: new Date().toISOString() }; ctx.posts.push(post);
            // Ghost adds default node fields while serializing.
            const state = JSON.parse(post.lexical); state.root.direction = null; state.root.textFormat = 0; post.lexical = JSON.stringify(state);
            if (ctx.failCreate) { ctx.failCreate = false; res.destroy(); return; }
            reply({ posts: [post] }); return;
        }
        ctx.updates++;
        const post = ctx.posts.find((p: any) => url.pathname.includes('/' + p.id + '/'));
        if (data.updated_at !== post.updated_at || ctx.forceConflict) { res.statusCode = 409; reply({ errors: [] }); return; }
        Object.assign(post, data, { updated_at: new Date(Date.now() + ctx.updates).toISOString() }); reply({ posts: [post] });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    ctx.settings = { url: `http://127.0.0.1:${(server.address() as any).port}`, key };
    ctx.assets = new ArticleAssets(path.join(directory, 'assets'));
    ctx.publisher = new GhostPublisher(path.join(directory, 'publications'), ctx.assets);
    try { await run(ctx); } finally { await ctx.publisher.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
}

test('Ghost conversion keeps native prose and code, and isolates a table as an HTML card', () => {
    const doc = documentFromMarkdown(article.markdown), output = ghostDocument(doc);
    assert.equal(output.root.children![0].type, 'extended-heading');
    assert.equal(output.root.children![1].children![0].type, 'extended-text');
    const code = output.root.children!.find(n => n.type === 'codeblock')!;
    assert.equal(code.language, 'python'); assert.equal(code.code, '  print("```")');
    const table = output.root.children!.find(n => n.type === 'html')!; assert.match(table.html, /<table>.*O\(1\)/);
    assert.match(documentMarkdown(doc), /````python\n  print\("```"\)/);
    assert.throws(() => validateDocument({ version: 1, root: { type: 'root', children: [{ type: 'unsupported-card' }] } }), /지원하지/);
});
test('URL and document boundaries reject unsafe sources without HTML injection', () => {
    assert.throws(() => ghostUrl('https://u:password@example.com'));
    assert.throws(() => ghostUrl('http://example.com'));
    assert.equal(ghostUrl('https://example.com/blog/ghost/'), 'https://example.com/blog/');
    assert.throws(() => ghostToken('content-api-key'));
    const doc = documentFromMarkdown('![<script>](https://example.com/a.png "caption <b>")');
    assert.match(documentHtml(doc), /alt="&lt;script&gt;"/); assert.doesNotMatch(documentHtml(doc), /<script>/);
    assert.throws(() => ghostDocument(documentFromMarkdown('![local](./local.png)')), /이미지/);
});
test('Ghost receives a separate title, no display divider, and preserves authored body headings and dividers', async () => fixture(async ({ publisher, settings, posts }) => {
    const markdown = '# 본문의 제목\n\n설명\n\n---\n\n본문';
    for (const document of [undefined, documentFromMarkdown(markdown)]) {
        await publisher.publish(settings, '/title.py', { title: '편집한 제목', markdown, document });
        assert.equal(posts[0].title, '편집한 제목');
        const nodes = JSON.parse(posts[0].lexical!).root.children;
        assert.equal(nodes[0].tag, 'h1');
        assert.equal(nodes[0].children[0].text, '본문의 제목');
        assert.equal(nodes.filter((node: any) => node.type === 'horizontalrule').length, 1);
        assert.equal(nodes[2].type, 'horizontalrule');
    }
    const document = { ...documentFromMarkdown('# 이전 제목\n\n---\n\n본문'), titleInDocument: true as const };
    await publisher.publish(settings, '/legacy-title.py', { title: '이전 제목', markdown: '---\n\n본문', document });
    assert.equal(posts[1].title, '이전 제목');
    const nodes = JSON.parse(posts[1].lexical!).root.children;
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].type, 'paragraph');
}));

test('draft save, update, explicit publish and later save reuse one post and preserve published status', async () => fixture(async ({ publisher, settings, posts, ...ctx }) => {
    const first = await publisher.publish(settings, '/solve.py', article);
    assert.equal(first.status, 'draft'); assert.ok(first.postId);
    await publisher.publish(settings, '/solve.py', article);
    await publisher.publish(settings, '/solve.py', { ...article, markdown: article.markdown + '\n\n수정.' });
    await publisher.publish(settings, '/solve.py', article, true);
    const last = await publisher.publish(settings, '/solve.py', { ...article, title: '다음 제목' });
    assert.equal(last.status, 'published'); assert.equal(posts.length, 1); assert.equal(posts[0].title, '다음 제목');
}));
test('a lost create response is recovered by the persistent slug with no duplicate', async () => fixture(async ctx => {
    ctx.failCreate = true;
    await assert.rejects(ctx.publisher.publish(ctx.settings, '/solve.py', article), /연결/);
    const state = await ctx.publisher.publish(ctx.settings, '/solve.py', article);
    assert.equal(state.postId, ctx.posts[0].id); assert.equal(ctx.creates, 1); assert.equal(ctx.updates, 0);
}));
test('automatic Draft saves stay private and cannot modify or unpublish an already published post', async () => fixture(async ctx => {
    await ctx.publisher.publish(ctx.settings, '/auto.py', article, false, { draftOnly: true });
    assert.equal(ctx.posts[0].status, 'draft');
    await ctx.publisher.publish(ctx.settings, '/auto.py', article, true);
    assert.equal(ctx.posts[0].status, 'published');
    const updates = ctx.updates;
    await assert.rejects(ctx.publisher.publish(ctx.settings, '/auto.py', { ...article, title: '새 제목' }, false, { draftOnly: true }), /이미 공개된 글/);
    assert.equal(ctx.posts[0].title, article.title);
    assert.equal(ctx.posts[0].status, 'published');
    assert.equal(ctx.updates, updates);
    await ctx.publisher.publish(ctx.settings, '/auto.py', { ...article, title: '명시적 수정' }, false);
    assert.equal(ctx.posts[0].status, 'published');
    assert.equal(ctx.posts[0].title, '명시적 수정');
}));
test('export tags create once, update without body edits, and preserve existing Ghost tags and their order', async () => fixture(async ctx => {
    const tagged = { ...article, tags: [' 알고리즘 ', 'PS', 'ps', 'segment tree'] };
    const first = await ctx.publisher.publish(ctx.settings, '/tags.py', tagged);
    assert.deepEqual(ctx.posts[0].tags, [{ name: '알고리즘' }, { name: 'PS' }, { name: 'segment tree' }]);
    assert.equal(first.localHash, articleHash(tagged));
    assert.notEqual(articleHash(tagged), articleHash(article));
    await ctx.publisher.publish(ctx.settings, '/tags.py', tagged);
    assert.equal(ctx.updates, 0);
    ctx.posts[0].tags.unshift({ id: 'existing-tag', name: 'Ghost에서 추가' });
    await ctx.publisher.publish(ctx.settings, '/tags.py', { ...article, tags: ['ps', '새 태그'] });
    assert.equal(ctx.updates, 1);
    assert.deepEqual(ctx.posts[0].tags, [{ id: 'existing-tag', name: 'Ghost에서 추가' }, { name: '알고리즘' }, { name: 'PS' }, { name: 'segment tree' }, { name: '새 태그' }]);
    await ctx.publisher.publish(ctx.settings, '/tags.py', { ...article, tags: [] });
    assert.equal(ctx.posts[0].tags.length, 5);
    assert.equal(ctx.updates, 1);
    ctx.forceConflict = true;
    await assert.rejects(ctx.publisher.publish(ctx.settings, '/tags.py', { ...article, tags: ['경합'] }), /변경/);
    assert.equal(ctx.posts[0].tags.length, 5);
}));
test('a lost tagged creation recovers without duplicate posts or tag updates', async () => fixture(async ctx => {
    const tagged = { ...article, tags: ['PS', 'segment tree'] };
    ctx.failCreate = true;
    await assert.rejects(ctx.publisher.publish(ctx.settings, '/tags.py', tagged), /연결/);
    await ctx.publisher.publish(ctx.settings, '/tags.py', tagged);
    assert.equal(ctx.creates, 1); assert.equal(ctx.updates, 0);
    assert.deepEqual(ctx.posts[0].tags.map((tag: any) => tag.name), tagged.tags);
}));
test('remote edits and updated_at races cannot be silently overwritten', async () => fixture(async ctx => {
    await ctx.publisher.publish(ctx.settings, '/solve.py', article);
    ctx.posts[0].title = 'Ghost에서 고친 제목';
    await assert.rejects(ctx.publisher.publish(ctx.settings, '/solve.py', article), /Ghost에서 수정/);
    assert.equal(ctx.updates, 0);
    ctx.posts[0].title = article.title; ctx.forceConflict = true;
    await assert.rejects(ctx.publisher.publish(ctx.settings, '/solve.py', { ...article, title: '여기서 수정' }), /변경/);
    assert.equal(ctx.posts[0].title, article.title);
}));
test('separate windows share a short claim lock and never create two posts', async () => fixture(async ctx => {
    const other = new GhostPublisher(ctx.publisher.directory, ctx.assets); ctx.delay = 100;
    try {
        const results = await Promise.allSettled([ctx.publisher.publish(ctx.settings, '/solve.py', article), other.publish(ctx.settings, '/solve.py', article)]);
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(ctx.creates, 1);
        assert.equal((await other.state(ctx.settings, '/solve.py')).busy, false);
    } finally { await other.close(); }
}));
test('local images upload once, are reused on retry, and keep alt text and caption', async () => fixture(async ctx => {
    const src = await ctx.assets.put(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
    const doc = documentFromMarkdown('image'); doc.root.children!.push({ type: 'article-image', version: 1, src, alt: '설명', caption: '<캡션>' });
    const value = { title: '그림', markdown: documentMarkdown(doc), document: doc };
    ctx.failCreate = true; await assert.rejects(ctx.publisher.publish(ctx.settings, '/image.py', value));
    await ctx.publisher.publish(ctx.settings, '/image.py', value);
    assert.equal(ctx.uploads, 1); assert.equal(ctx.creates, 1);
    const image = JSON.parse(ctx.posts[0].lexical).root.children.find((n: any) => n.type === 'image');
    assert.equal(image.src, 'https://cdn.example.com/1.png'); assert.equal(image.alt, '설명'); assert.equal(image.caption, '&lt;캡션&gt;');
    assert.throws(() => ctx.assets.file('psb-image:../../secret'));
    await assert.rejects(ctx.assets.put(Buffer.from('<svg></svg>')), /이미지/);
    const mapped = await mapImages(doc, async () => 'https://example.com/image.png'); assert.equal(doc.root.children![1].src, src); assert.equal(mapped.root.children![1].src, 'https://example.com/image.png');
}));

test('Markdown output preserves marked word boundaries, literal prefixes and nested code', () => {
    const doc = documentFromMarkdown('paragraph');
    doc.root.children![0].children = [{ type: 'text', version: 1, text: ' bold ', format: 1 }];
    assert.equal(documentMarkdown(doc), ' **bold** ');
    assert.match(documentHtml(documentFromMarkdown(documentMarkdown(doc))), /<strong>bold<\/strong>/);
    for (const literal of ['# literal', '- plain text', '1. ordinary text', '~~not struck~~']) {
        doc.root.children![0].children = [{ type: 'text', version: 1, text: literal, format: 0 }];
        assert.equal(documentFromMarkdown(documentMarkdown(doc)).root.children![0].type, 'paragraph');
        assert.equal(documentFromMarkdown(documentMarkdown(doc)).root.children![0].children![0].text, literal);
    }
    for (const source of ['> ```python\n>     print(1)\n> ```', '- item\n\n  ```python\n      print(1)\n  ```', '- outer\n  - inner']) {
        const original = documentFromMarkdown(source), roundTrip = documentFromMarkdown(documentMarkdown(original));
        assert.equal(documentHtml(roundTrip), documentHtml(original));
    }
    const image = ghostDocument(documentFromMarkdown('![alt](https://example.com/a.png "caption")'));
    assert.equal(image.root.children![0].type, 'image');
    assert.match(ghostDocument(documentFromMarkdown('- [x] done')).root.children![0].html, /☑ done/);
});

test('malformed persisted node structures fail before reaching the editor', () => {
    for (const root of [{ type: 'root', version: 1 }, { type: 'root', version: 1, children: [{ type: 'root', version: 1, children: [] }] }, { type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text: 'x', children: [] }] }] }]) {
        assert.throws(() => validateDocument({ version: 1, root }), /블록 구조/);
    }
});
