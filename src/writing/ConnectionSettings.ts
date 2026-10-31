import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parseEnv } from 'node:util';

export const PUBLIC_API = 'https://psb-backend.shinem.dev/api';
export interface ConnectionEnvironment { [name: string]: string | undefined; PSB_API_URL?: string }


export function serviceUrl(value: string) {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
        throw new Error('서버 주소는 HTTPS 또는 로컬 HTTP 주소여야 합니다.');
    }
    return url.href.replace(/\/$/, '');
}

/** Read only the extension checkout, never the user's active problem folder. */
export async function loadConnectionEnvironment(extensionPath: string, development: boolean): Promise<ConnectionEnvironment> {
    if (!development) return {};
    try {
        const values = parseEnv(await readFile(path.join(extensionPath, '.env'), 'utf8'));
        return { PSB_API_URL: values.PSB_API_URL };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw new Error('확장 루트의 .env 파일을 읽을 수 없습니다.');
    }
}

export function resolveConnectionSettings(environment: ConnectionEnvironment = process.env, development: ConnectionEnvironment = {}) {
    return { apiUrl: serviceUrl(environment.PSB_API_URL?.trim() || development.PSB_API_URL?.trim() || PUBLIC_API) };
}

/** Development and integration runs require a reachable, compatible backend. */
export async function requireBackend(base: string, request: typeof fetch = fetch): Promise<void> {
    const url = serviceUrl(base);
    let response: Response;
    try {
        response = await request(url + '/config', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    } catch { throw new Error(`백엔드에 연결할 수 없습니다: ${url}. 서버를 실행하고 PSB_API_URL을 확인해 주세요.`); }
    const config = await response.json().catch(() => ({})) as { protocol?: string };
    if (!response.ok || config.protocol !== 'file-writing-v2') throw new Error('호환되는 PS-Blogself 백엔드가 필요합니다. 서버 주소와 버전을 확인해 주세요.');
}
