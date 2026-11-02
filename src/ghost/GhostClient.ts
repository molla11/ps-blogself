import { createHmac } from 'node:crypto';

export interface GhostSettings { url: string; key: string }
export interface GhostTag { id?: string; name: string }
export interface GhostPost { id: string; title: string; lexical: string; status: string; updated_at: string; url?: string; slug: string; tags?: GhostTag[] }
export class GhostError extends Error { constructor(message: string, readonly status = 0) { super(message); } }
export function ghostUrl(value: string): string {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Ghost 주소는 HTTPS를 사용해 주세요. 로컬 테스트만 HTTP를 지원합니다.');
    url.pathname = url.pathname.replace(/\/ghost(?:\/.*)?$/, '').replace(/\/$/, '') + '/';
    return url.href;
}
export function ghostToken(key: string, now = Date.now()): string {
    const [id, secret, extra] = key.split(':');
    if (!/^[a-f\d]{24}$/i.test(id || '') || !/^[a-f\d]{64}$/i.test(secret || '') || extra) throw new Error('Ghost Admin API 키 형식을 확인해 주세요.');
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const token = `${encode({ alg: 'HS256', typ: 'JWT', kid: id })}.${encode({ iat: Math.floor(now / 1000) - 5, exp: Math.floor(now / 1000) + 295, aud: '/admin/' })}`;
    return token + '.' + createHmac('sha256', Buffer.from(secret, 'hex')).update(token).digest('base64url');
}
export class GhostClient {
    readonly url: string;
    constructor(private readonly settings: GhostSettings) { this.url = ghostUrl(settings.url); ghostToken(settings.key); }
    private async request(route: string, method = 'GET', body?: object | FormData): Promise<any> {
        let response: Response;
        try {
            response = await fetch(new URL('ghost/api/admin/' + route, this.url), {
                method, redirect: 'error', signal: AbortSignal.timeout(30000),
                headers: { Authorization: 'Ghost ' + ghostToken(this.settings.key), 'Accept-Version': 'v5.0', ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
                body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
            });
        } catch { throw new GhostError('Ghost에 연결하지 못했습니다. 주소와 네트워크를 확인하고 다시 시도해 주세요.'); }
        if (!response.ok) {
            const labels: Record<number, string> = { 401: 'Ghost Admin API 키를 확인해 주세요.', 403: 'Ghost에서 이 작업을 허용하지 않았습니다.', 404: 'Ghost 글 또는 API 주소를 찾을 수 없습니다.', 409: 'Ghost에서 글이 변경되었습니다. Ghost 편집기에서 확인해 주세요.', 413: 'Ghost 이미지 업로드 제한을 초과했습니다.', 415: 'Ghost에서 지원하지 않는 이미지입니다.', 422: 'Ghost가 글 형식을 처리하지 못했습니다.', 429: 'Ghost 요청이 많습니다. 잠시 후 다시 시도해 주세요.' };
            throw new GhostError(labels[response.status] || `Ghost 요청에 실패했습니다 (${response.status}). 다시 시도해 주세요.`, response.status);
        }
        const data = await response.text();
        if (data.length > 5_000_000) throw new GhostError('Ghost 응답이 너무 큽니다.');
        try { return JSON.parse(data); } catch { throw new GhostError('Ghost 응답 형식을 확인할 수 없습니다.'); }
    }
    async check(): Promise<void> { await this.request('posts/?limit=1&fields=id'); }
    async find(id: string | undefined, slug: string): Promise<GhostPost | undefined> {
        try {
            const data = await this.request(id ? `posts/${encodeURIComponent(id)}/?formats=lexical&include=tags` : `posts/?filter=${encodeURIComponent('slug:' + slug)}&limit=1&formats=lexical&include=tags`);
            return data.posts?.[0];
        } catch (error) { if (error instanceof GhostError && error.status === 404 && id) return undefined; throw error; }
    }
    async save(post: { title: string; lexical: string; slug?: string; status: string; tags?: GhostTag[] }, remote?: GhostPost): Promise<GhostPost> {
        const data = await this.request(remote ? `posts/${encodeURIComponent(remote.id)}/?formats=lexical` : 'posts/?formats=lexical', remote ? 'PUT' : 'POST', { posts: [{ ...post, ...(remote ? { updated_at: remote.updated_at } : {}) }] });
        if (!data.posts?.[0]?.id) throw new GhostError('Ghost 저장 결과를 확인할 수 없습니다. 다시 시도하면 기존 글을 먼저 확인합니다.');
        return data.posts[0];
    }
    async upload(bytes: Uint8Array, mime: string, name: string): Promise<string> {
        const body = new FormData(); body.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), name); body.set('purpose', 'image'); body.set('ref', name);
        const result = await this.request('images/upload/', 'POST', body);
        const value = result.images?.[0]?.url;
        if (typeof value !== 'string') throw new GhostError('Ghost 이미지 주소를 확인할 수 없습니다.');
        const url = new URL(value, this.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.origin !== new URL(this.url).origin && url.protocol !== 'https:' || url.username || url.password) throw new GhostError('Ghost 이미지 주소가 올바르지 않습니다.');
        return url.href;
    }
}
