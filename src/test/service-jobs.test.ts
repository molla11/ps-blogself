import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { JobRouter, isServerTarget } from '../writing/JobRouter';
import { WritingRequest } from '../writing/model';

const request: WritingRequest = { requestId: 'request-1', kind: 'prepare_blog', instructions: '',
    source: { fileName: 'solve.py', language: 'python', initialCode: '', finalCode: 'print(1)', changes: [{ index: 0, at: new Date(0).toISOString(), diff: '+print(1)' }] } };
function harness() {
    const calls: unknown[][] = [];
    const connection = { base: 'http://127.0.0.1:4000/api',
        credentials: async () => ({ token: 'session-token', user: { id: 'owner' } }),
        request: async (...args: unknown[]) => { calls.push(args); return { id: request.requestId, status: 'completed', progress: 100 }; },
    };
    return { calls, connection, jobs: new JobRouter(connection as any) };
}

test('all job operations use the authenticated backend and keep the original target', async () => {
    const { calls, connection, jobs } = harness();
    const target = await jobs.target();
    assert.deepEqual(target, { kind: 'server', base: connection.base, owner: 'owner' });
    connection.base = 'http://127.0.0.1:4001/api';
    await jobs.create(request, target); await jobs.job('job/1', target); await jobs.retry('job/1', target); await jobs.cancel('job/1', target);
    assert.deepEqual(calls.map(call => call.slice(0, 2)), [['/jobs', 'POST'], ['/jobs/job%2F1', 'GET'], ['/jobs/job%2F1/retry', 'POST'], ['/jobs/job%2F1/cancel', 'POST']]);
    for (const call of calls) assert.deepEqual(call.slice(3), [target.base, 'owner']);
});

test('legacy or malformed pending jobs cannot silently execute on a different service', async () => {
    const { jobs, calls } = harness();
    for (const target of [undefined, { kind: 'direct' }, { kind: 'server' }, { kind: 'server', base: 'http://remote.test/api', owner: 'owner' }]) {
        assert.equal(isServerTarget(target), false);
        assert.throws(() => jobs.create(request, target as any), /이전 실행 방식/);
        assert.throws(() => jobs.cancel('old-job', target as any), /이전 실행 방식/);
        await assert.rejects(jobs.watch('old-job', target as any, () => {}, new AbortController().signal), /이전 실행 방식/);
    }
    assert.equal(calls.length, 0);
});

test('server failure does not run locally or submit another request', async () => {
    const { jobs, connection, calls } = harness();
    connection.request = async (...args) => { calls.push(args); throw new Error('server unavailable'); };
    await assert.rejects(jobs.create(request, await jobs.target()), /server unavailable/);
    assert.equal(calls.length, 1);
});

test('a broken event stream resumes the existing job without submitting it again', async () => {
    const { jobs, calls } = harness(), previousFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new TypeError('stream disconnected'); };
    try {
        const result = await jobs.watch('existing-job', await jobs.target(), () => {}, new AbortController().signal);
        assert.equal(result.status, 'completed');
        assert.deepEqual(calls.map(call => call.slice(0, 2)), [['/jobs/existing-job', 'GET']]);
    } finally { globalThis.fetch = previousFetch; }
});

test('selected aliases reach the backend without exposing provider or reasoning settings', async () => {
    const { jobs, connection, calls } = harness();
    connection.request = async (...args: unknown[]) => {
        calls.push(args);
        if (args[0] === '/config') return { writingModels: [{ id: 'opus5.5' }] } as any;
        return { id: 'job', status: 'completed', progress: 100 };
    };
    await jobs.create({ ...request, model: 'opus5.5' }, await jobs.target());
    assert.deepEqual(calls.map(call => call.slice(0, 2)), [['/config', 'GET'], ['/jobs', 'POST']]);
    assert.equal((calls[1][2] as WritingRequest).model, 'opus5.5');
    assert.doesNotMatch(JSON.stringify(calls[1][2]), /claude|anthropic|reasoning|provider/);
});

test('an old server cannot silently ignore a selected paid model and generate using its default', async () => {
    const { jobs, calls } = harness();
    await assert.rejects(jobs.create({ ...request, model: 'astra' }, await jobs.target()), /서버 업데이트/);
    assert.equal(calls.length, 1); assert.equal(calls[0][0], '/config');
    assert.throws(() => jobs.create({ ...request, model: 'openai/gpt-6-astra' as any },
        { kind: 'server', base: 'http://127.0.0.1:4000/api', owner: 'owner' }), /모델/);
    assert.equal(calls.length, 1);
});
