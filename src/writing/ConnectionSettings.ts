import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parseEnv } from 'node:util';

export const PUBLIC_API = 'https://psb-backend.shinem.dev/api';
export interface ConnectionEnvironment { [name: string]: string | undefined; PSB_AI_MODE?: string; PSB_API_URL?: string }
export interface ConnectionPreferences { mode?: string; apiUrl?: string }

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
        return { PSB_AI_MODE: values.PSB_AI_MODE, PSB_API_URL: values.PSB_API_URL };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw new Error('확장 루트의 .env 파일을 읽을 수 없습니다.');
    }
}

export function resolveConnectionSettings(preferences: ConnectionPreferences, environment: ConnectionEnvironment = process.env, development: ConnectionEnvironment = {}) {
    const mode = environment.PSB_AI_MODE?.trim() || development.PSB_AI_MODE?.trim() || preferences.mode || 'server';
    if (mode !== 'server' && mode !== 'direct') throw new Error('PSB_AI_MODE는 server 또는 direct여야 합니다.');
    return {
        mode,
        apiUrl: serviceUrl(environment.PSB_API_URL?.trim() || development.PSB_API_URL?.trim() || preferences.apiUrl || PUBLIC_API),
    };
}
