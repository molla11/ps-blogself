import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { watchFile, unwatchFile } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';

const queues = new Map<string, Promise<unknown>>();

/** Only local read/modify/write work belongs inside this lock, never an AI call. */
export function withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
    const key = path.resolve(file);
    const operation = (queues.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
        await mkdir(path.dirname(key), { recursive: true, mode: 0o700 });
        let compromised: Error | undefined;
        const release = await lockfile.lock(key, {
            realpath: false, stale: 10000, update: 2000,
            retries: { retries: 120, minTimeout: 25, maxTimeout: 100, factor: 1.1 },
            onCompromised: error => { compromised = error; },
        });
        try {
            const result = await action();
            if (compromised) throw compromised;
            return result;
        } finally { await release().catch(error => { if (!compromised) throw error; }); }
    });
    queues.set(key, operation);
    void operation.finally(() => { if (queues.get(key) === operation) queues.delete(key); }).catch(() => {});
    return operation;
}

export async function readJson<T>(file: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(file, 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export async function atomicWrite(file: string, data: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
        await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
        await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
}

/** Stat polling also observes atomic replacements on Windows and WSL mounts. */
export function observeFile(file: string, changed: () => void): { dispose(): void } {
    const listener = () => changed();
    watchFile(file, { persistent: false, interval: 400 }, listener);
    return { dispose: () => unwatchFile(file, listener) };
}
