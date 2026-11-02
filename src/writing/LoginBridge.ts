import { createServer } from 'node:http';

// Shared with the backend login page. Bind only while a login is pending.
export const LOGIN_BRIDGE_URL = 'http://127.0.0.1:49629/connect';

export async function startLoginBridge(origin: string, id: string, expiresAt: number) {
    let browser: string | undefined;
    let closed = false;
    const server = createServer(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        const reject = (status: number) => { response.writeHead(status); response.end(); };
        // Origin + Host checks prevent cross-site requests and DNS rebinding.
        if (request.headers.host !== '127.0.0.1:49629' || request.headers.origin !== origin) return reject(403);
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        if (request.url !== '/connect') return reject(404);
        if (closed || Date.now() >= expiresAt) return reject(410);
        if (request.method === 'OPTIONS') {
            if (request.headers['access-control-request-method'] !== 'POST') return reject(405);
            response.setHeader('Access-Control-Allow-Methods', 'POST');
            response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            return reject(204);
        }
        if (request.method !== 'POST') return reject(405);
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') return reject(415);
        if (Number(request.headers['content-length']) > 1024) return reject(413);
        try {
            let size = 0;
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
                size += chunk.length;
                if (size > 1024) { reject(413); return; }
                chunks.push(chunk);
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (typeof body?.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(body.nonce)) return reject(400);
            if (browser && browser !== body.nonce) return reject(409);
            browser = body.nonce;
            // Never send the native PKCE verifier or credentials to the browser.
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ protocol: 'psb-login-v1', id, expiresAt }));
        } catch { if (!response.headersSent) reject(400); else response.end(); }
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.maxConnections = 8;
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(49629, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    }).catch((error: NodeJS.ErrnoException) => {
        server.close();
        throw new Error(error.code === 'EADDRINUSE'
            ? '로그인 연결 포트가 사용 중입니다. 다른 VS Code 창에서 진행 중인 로그인을 완료하거나 취소한 뒤 다시 시도해 주세요.'
            : '브라우저와 연결할 로컬 로그인 창구를 열 수 없습니다.');
    });
    const dispose = () => {
        if (closed) return;
        closed = true; clearTimeout(timer); server.close(); server.closeAllConnections();
    };
    const timer = setTimeout(dispose, Math.max(1, expiresAt - Date.now()));
    timer.unref(); server.unref();
    return { dispose };
}
