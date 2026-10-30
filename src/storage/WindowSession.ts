import { createServer, createConnection, Server } from 'node:net';
import { randomUUID } from 'node:crypto';

export interface SessionOwner { id: string; port: number }

/** A process-lifetime endpoint avoids PID reuse and stale heartbeat guesses. */
export class WindowSession {
    readonly id = randomUUID();
    private server?: Server;
    private starting?: Promise<SessionOwner>;
    private closed = false;
    owner(): Promise<SessionOwner> {
        if (this.closed) return Promise.reject(new Error('창을 종료하고 있습니다.'));
        return this.starting ||= new Promise((resolve, reject) => {
            const server = this.server = createServer(socket => {
                socket.on('error', () => {});
                socket.setTimeout(1000, () => socket.destroy());
                socket.end(this.id);
            });
            server.on('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.unref();
                resolve({ id: this.id, port: (server.address() as { port: number }).port });
            });
        });
    }
    async close() {
        this.closed = true;
        await this.starting?.catch(() => {});
        if (this.server?.listening) await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
    }
    static alive(owner?: SessionOwner): Promise<boolean> {
        if (!owner || !Number.isInteger(owner.port) || owner.port < 1 || owner.port > 65535 || typeof owner.id !== 'string') return Promise.resolve(false);
        return new Promise(resolve => {
            const socket = createConnection({ host: '127.0.0.1', port: owner.port });
            let data = '', done = false;
            const finish = (alive: boolean) => { if (done) return; done = true; socket.destroy(); resolve(alive); };
            socket.setTimeout(1000, () => finish(true));
            socket.on('data', chunk => { data += chunk; if (data.length > 100) finish(false); });
            socket.on('end', () => finish(data === owner.id));
            socket.on('error', error => finish(!['ECONNREFUSED', 'ECONNRESET'].includes((error as NodeJS.ErrnoException).code || '')));
        });
    }
}
