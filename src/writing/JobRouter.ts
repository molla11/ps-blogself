import { serviceUrl } from './ConnectionSettings';
import { validateRequest } from './RequestValidation';
import type { ServiceConnection } from './ServiceConnection';
import { WritingJob, WritingRequest } from './model';

export interface JobTarget { kind: 'server'; base: string; owner: string }
export function isServerTarget(value: unknown): value is JobTarget {
    if (!value || typeof value !== 'object') return false;
    const target = value as Partial<JobTarget>;
    if (target.kind !== 'server' || typeof target.base !== 'string' || typeof target.owner !== 'string' || !target.owner) return false;
    try { serviceUrl(target.base); return true; } catch { return false; }
}
function requireTarget(target: unknown): asserts target is JobTarget {
    if (!isServerTarget(target)) throw new Error('이전 실행 방식의 작업입니다. 새 요청을 준비해 주세요.');
}
export class JobRouter {
    constructor(readonly connection: ServiceConnection) {}
    async target(interactive = true): Promise<JobTarget> {
        const base = this.connection.base, credentials = await this.connection.credentials(interactive, base);
        return { kind: 'server', base, owner: credentials.user.id };
    }
    create(request: WritingRequest, target: JobTarget) {
        requireTarget(target);
        validateRequest(request);
        return this.connection.request<WritingJob>('/jobs', 'POST', request, target.base, target.owner);
    }
    job(id: string, target: JobTarget) {
        requireTarget(target);
        return this.connection.request<WritingJob>('/jobs/' + encodeURIComponent(id), 'GET', undefined, target.base, target.owner);
    }
    retry(id: string, target: JobTarget) {
        requireTarget(target);
        return this.connection.request<WritingJob>('/jobs/' + encodeURIComponent(id) + '/retry', 'POST', {}, target.base, target.owner);
    }
    cancel(id: string, target: JobTarget) {
        requireTarget(target);
        return this.connection.request<WritingJob>('/jobs/' + encodeURIComponent(id) + '/cancel', 'POST', {}, target.base, target.owner);
    }
    async watch(id: string, target: JobTarget, changed: (job: WritingJob) => void, signal: AbortSignal): Promise<WritingJob> {
        requireTarget(target);
        try {
            const credentials = await this.connection.credentials(false, target.base);
            if (credentials.user.id !== target.owner) throw new Error('다른 계정의 작업입니다.');
            const response = await fetch(target.base + '/jobs/' + encodeURIComponent(id) + '/events', {
                redirect: 'error', signal, headers: { Authorization: 'Bearer ' + credentials.token },
            });
            if (!response.ok || !response.body) throw new Error('진행 상황 연결을 다시 시도합니다.');
            const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
            try {
                while (true) {
                    const { done, value } = await reader.read(); if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    if (buffer.length > 1000000) throw new Error('응답이 너무 큽니다.');
                    let index;
                    while ((index = buffer.indexOf('\n\n')) >= 0) {
                        const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
                        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
                        if (!data) continue;
                        const job = JSON.parse(data) as WritingJob;
                        if (job.id !== id) continue;
                        changed(job);
                        if (!['queued', 'running'].includes(job.status)) return job;
                    }
                }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        } catch (error) { if (signal.aborted) throw error; }
        // Reconnect by reading the existing job. Never resubmit an AI request.
        while (true) {
            signal.throwIfAborted();
            const job = await this.job(id, target); changed(job);
            if (!['queued', 'running'].includes(job.status)) return job;
            await new Promise<void>((resolve, reject) => {
                const abort = () => { clearTimeout(timer); reject(signal.reason); };
                const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
                signal.addEventListener('abort', abort, { once: true });
            });
        }
    }
}
