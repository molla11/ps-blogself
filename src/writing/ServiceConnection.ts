import * as vscode from 'vscode';
import { createHash, randomBytes } from 'crypto';

export const PUBLIC_API = 'https://psb-backend.shinem.dev/api';
export interface Account { id: string; email: string; usage?: { requests: number; dailyLimit: number } }
interface Credentials { token: string; user: Account }
export class ServiceError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export function serviceUrl(value: string) {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
        throw new Error('서버 주소는 HTTPS 또는 로컬 HTTP 주소여야 합니다.');
    }
    return url.href.replace(/\/$/, '');
}
export class ServiceConnection {
    readonly changed = new vscode.EventEmitter<void>();
    private login?: Promise<Credentials>;
    constructor(private context: vscode.ExtensionContext) {}
    get base() {
        const configured = vscode.workspace.getConfiguration('psb').inspect<string>('apiUrl')?.globalValue;
        return serviceUrl(configured || process.env.PSB_API_URL || PUBLIC_API);
    }
    private key(base: string) { return 'psb.account.' + createHash('sha256').update(base).digest('hex'); }
    async saved(base = this.base): Promise<Credentials | undefined> {
        const raw = await this.context.secrets.get(this.key(base));
        if (!raw) return undefined;
        try { const data = JSON.parse(raw); return typeof data.token === 'string' && data.user?.id ? data : undefined; } catch { return undefined; }
    }
    async account() { return (await this.saved())?.user; }
    private async store(base: string, value: Credentials) {
        await this.context.secrets.store(this.key(base), JSON.stringify(value)); this.changed.fire(); return value;
    }
    async fetchJson<T>(base: string, route: string, method = 'GET', body?: unknown, token?: string): Promise<T> {
        let response: Response;
        try {
            response = await fetch(serviceUrl(base) + route, {
                method, redirect: 'error', signal: AbortSignal.timeout(20000),
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch { throw new Error('글쓰기 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'); }
        const data = await response.json().catch(() => ({})) as any;
        if (!response.ok) {
            if (response.status === 401 && token) { await this.context.secrets.delete(this.key(base)); this.changed.fire(); }
            throw new ServiceError(data.message || `요청을 처리하지 못했습니다 (${response.status}).`, response.status);
        }
        return data as T;
    }
    async credentials(interactive = true, base = this.base): Promise<Credentials> {
        const saved = await this.saved(base); if (saved) return saved;
        const config = await this.fetchJson<{ protocol: string; authMode: string }>(base, '/config');
        if (config.protocol !== 'file-writing-v2') throw new Error('글쓰기 서비스 버전을 확인해 주세요.');
        if (config.authMode === 'local' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) {
            return this.store(base, await this.fetchJson<Credentials>(base, '/auth/local', 'POST', {}));
        }
        if (!interactive) throw new Error('먼저 로그인해 주세요.');
        if (this.login) return this.login;
        this.login = Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '브라우저에서 GitHub 로그인을 완료해 주세요.', cancellable: true }, async (_progress, cancellation) => {
            const verifier = randomBytes(32).toString('base64url');
            const challenge = createHash('sha256').update(verifier).digest('base64url');
            const flow = await this.fetchJson<{ id: string; loginUrl: string }>(base, '/auth/start', 'POST', { challenge });
            if (new URL(flow.loginUrl).origin !== new URL(base).origin) throw new Error('로그인 주소를 확인할 수 없습니다.');
            if (!await vscode.env.openExternal(vscode.Uri.parse(flow.loginUrl))) throw new Error('로그인 브라우저를 열 수 없습니다.');
            const deadline = Date.now() + 10 * 60 * 1000;
            while (!cancellation.isCancellationRequested && Date.now() < deadline) {
                const result = await this.fetchJson<Credentials | { pending: true }>(base, '/auth/exchange', 'POST', { id: flow.id, verifier });
                if ('token' in result) return this.store(base, result);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            throw new Error(cancellation.isCancellationRequested ? '로그인을 취소했습니다.' : '로그인 시간이 초과되었습니다. 다시 시도해 주세요.');
        })).finally(() => { this.login = undefined; });
        return this.login;
    }
    async request<T>(route: string, method = 'GET', body?: unknown, base = this.base, owner?: string): Promise<T> {
        const credentials = await this.credentials(false, base);
        if (owner && credentials.user.id !== owner) throw new Error('이 작업을 시작한 계정으로 로그인해 주세요.');
        return this.fetchJson(base, route, method, body, credentials.token);
    }
    async configure() {
        const saved = await this.saved();
        if (!saved) { await this.credentials(); return; }
        const choice = await vscode.window.showQuickPick(['사용량 확인', '로그아웃'], { title: saved.user.email });
        if (choice === '사용량 확인') {
            const user = await this.request<Account>('/me');
            await this.store(this.base, { ...saved, user });
            void vscode.window.showInformationMessage(`오늘 AI 요청 ${user.usage?.requests || 0} / ${user.usage?.dailyLimit || 0}회`);
        } else if (choice === '로그아웃') {
            try { await this.request('/logout', 'POST'); } finally { await this.context.secrets.delete(this.key(this.base)); this.changed.fire(); }
        }
    }
}
