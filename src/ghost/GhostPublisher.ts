import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { ArticleDocument, documentFromMarkdown, ghostDocument } from '../writing/ArticleDocument';
import { separateArticleTitle } from '../writing/ArticleContent';
import { atomicWrite, readJson, withFileLock } from '../storage/SharedFiles';
import { SessionOwner, WindowSession } from '../storage/WindowSession';
import { ArticleAssets, mapImages } from './ArticleAssets';
import { GhostClient, GhostPost, GhostSettings } from './GhostClient';
import { normalizeExportTags } from '../settings/ExportTags';

export interface PublishArticle { title: string; markdown: string; document?: ArticleDocument; tags?: string[] }
interface Publication {
    slug: string; postId?: string; remoteHash?: string; localHash?: string; status?: string; updatedAt?: string;
    pending?: { owner: SessionOwner; token: string };
}
export interface GhostState { connected: boolean; site?: string; postId?: string; editorUrl?: string; status?: string; localHash?: string; updatedAt?: string; busy?: boolean; error?: string }
function stable(value: any): any { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])); return value; }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export const articleHash = (article: PublishArticle) => {
    article = separateArticleTitle(article);
    const tags = normalizeExportTags(article.tags || []);
    return hash({ title: article.title, document: article.document || documentFromMarkdown(article.markdown), ...(tags.length ? { tags } : {}) });
};
function lexicalContent(value: any): any {
    if (Array.isArray(value)) return value.map(lexicalContent);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key, val]) => !(['direction', 'style', 'textStyle', 'detail', 'indent', 'textFormat', 'format', 'mode', 'rel', 'target', 'title'].includes(key) && (val === null || val === undefined || val === '' || val === 0 || key === 'mode' && val === 'normal'))).map(([key, val]) => [key, lexicalContent(val)]));
    return value;
}
function postHash(post: Pick<GhostPost, 'title' | 'lexical' | 'status'>) { return hash({ title: post.title, lexical: lexicalContent(JSON.parse(post.lexical || '{}')), status: post.status }); }
export class GhostPublisher {
    readonly session = new WindowSession();
    constructor(readonly directory: string, readonly assets: ArticleAssets) {}
    private file(settings: GhostSettings, filePath: string) { return path.join(this.directory, hash([new GhostClient(settings).url, filePath]) + '.json'); }
    async state(settings: GhostSettings | undefined, filePath: string): Promise<GhostState> {
        if (!settings) return { connected: false };
        const client = new GhostClient(settings), record = await readJson<Publication>(this.file(settings, filePath));
        return { connected: true, site: client.url, postId: record?.postId, editorUrl: record?.postId ? new URL(`ghost/#/editor/post/${record.postId}`, client.url).href : undefined, status: record?.status, localHash: record?.localHash, updatedAt: record?.updatedAt, busy: !!record?.pending && await WindowSession.alive(record.pending.owner) };
    }
    async publish(settings: GhostSettings, filePath: string, article: PublishArticle, publish = false, options: { draftOnly?: boolean } = {}): Promise<GhostState> {
        article = separateArticleTitle(article);
        if (!article.title.trim() || !article.markdown.trim()) throw new Error('글 제목과 본문을 먼저 작성해 주세요.');
        const additionalTags = normalizeExportTags(article.tags || []);
        const client = new GhostClient(settings), file = this.file(settings, filePath), token = randomUUID(), owner = await this.session.owner();
        const record = await withFileLock(file, async () => {
            const record = await readJson<Publication>(file) || { slug: 'psb-' + randomUUID() };
            if (record.pending && await WindowSession.alive(record.pending.owner)) throw new Error('다른 창에서 이 글을 Ghost에 저장 중입니다. 완료 후 다시 시도해 주세요.');
            record.pending = { owner, token }; await atomicWrite(file, record); return record;
        });
        try {
            const remote = await client.find(record.postId, record.slug);
            if (record.postId && !remote) throw new Error('연결된 Ghost 글이 삭제되었습니다. Ghost 연결을 확인해 주세요.');
            if (options.draftOnly && remote?.status === 'published') throw new Error('이미 공개된 글입니다. Draft 자동 업로드로 수정하지 않았습니다. Ghost에서 확인하거나 Publish를 선택해 주세요.');
            if (remote && !['draft', 'published'].includes(remote.status)) throw new Error('예약 또는 발송 상태인 글은 Ghost 편집기에서 수정해 주세요.');
            const document = await mapImages(article.document || documentFromMarkdown(article.markdown), async src => {
                if (!src.startsWith('psb-image:')) return src;
                const cache = path.join(this.directory, 'images', hash([client.url, src]) + '.json');
                const existing = await readJson<{ url: string }>(cache); if (existing) return existing.url;
                const { bytes, mime } = await this.assets.read(src), url = await client.upload(bytes, mime, src.slice(10) + '.' + mime.split('/')[1]);
                await atomicWrite(cache, { url }); return url;
            });
            // Ghost replaces tag relations: preserve their IDs and order, then append new names.
            const tags = (remote?.tags || []).map(({ id, name }) => ({ ...(id ? { id } : {}), name }));
            const names = new Set(tags.map(tag => tag.name.normalize('NFC').toLowerCase()));
            for (const name of additionalTags) if (!names.has(name.toLowerCase())) { names.add(name.toLowerCase()); tags.push({ name }); }
            const hasNewTags = tags.length > (remote?.tags?.length || 0);
            const desired = { title: article.title, lexical: JSON.stringify(ghostDocument(document)), status: publish || remote?.status === 'published' ? 'published' : 'draft', ...(tags.length ? { tags } : {}) };
            let saved: GhostPost;
            if (remote && postHash(remote) === postHash(desired) && !hasNewTags) saved = remote;
            else {
                if (remote && (!record.remoteHash || record.remoteHash !== postHash(remote))) {
                    // A recovered create may have been edited in Ghost before we received its ID.
                    await withFileLock(file, async () => { const latest = await readJson<Publication>(file); if (latest?.pending?.token === token) await atomicWrite(file, { ...latest, postId: remote.id, status: remote.status }); });
                    throw new Error('Ghost에서 수정한 내용이 있습니다. 덮어쓰지 않았습니다. Ghost 편집기에서 확인해 주세요.');
                }
                saved = await client.save({ ...desired, ...(!remote ? { slug: record.slug } : {}) }, remote);
            }
            await withFileLock(file, async () => {
                const latest = await readJson<Publication>(file); if (latest?.pending?.token !== token) throw new Error('Ghost 저장 권한이 변경되었습니다.');
                await atomicWrite(file, { ...latest, pending: undefined, postId: saved.id, remoteHash: postHash(saved), localHash: articleHash(article), status: saved.status, updatedAt: saved.updated_at });
            });
            return this.state(settings, filePath);
        } finally {
            await withFileLock(file, async () => { const latest = await readJson<Publication>(file); if (latest?.pending?.token === token) { delete latest.pending; await atomicWrite(file, latest); } });
        }
    }
    async close() { await this.session.close(); }
}
