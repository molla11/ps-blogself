import * as path from 'path';
import { createHash } from 'crypto';
import { createTwoFilesPatch } from 'diff';
import { FileHistory } from '../types';
import { isCosmeticChange } from './ChangeFilter';
import { WritingPreferences } from './WritingStyle';
import { checkInputSize, MAX_CHANGES, MAX_CODE_BYTES, MAX_RECONSTRUCTED_BYTES, InputSizeError, utf8Bytes } from './InputLimits';

export interface WritingStep {
    title: string;
    body: string;
    start: number;
    end: number;
}
export interface WritingPlan {
    title: string;
    summary: string;
    start: number;
    end: number;
    steps: WritingStep[];
}
export interface WritingSource {
    fileName: string;
    language: string;
    changes: { index: number; at: string; diff: string }[];
    initialCode: string;
    finalCode: string;
}
export interface WritingRequest {
    kind: 'prepare_blog' | 'write_blog';
    requestId: string;
    source: WritingSource;
    plan?: WritingPlan;
    instructions: string;
    priority?: 'interactive' | 'prefetch';
}
export interface WritingJob {
    id: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    progress: number;
    error?: string;
    errorCode?: string;
    result?: { plan?: WritingPlan; title?: string; markdown?: string };
    partial?: string;
}
export interface WritingDraft extends WritingPreferences {
    schemaVersion: 1;
    storageVersion?: number;
    editor?: { owner: import('../storage/WindowSession').SessionOwner; token: string };
    filePath: string;
    history: FileHistory;
    fingerprint: string;
    plan?: WritingPlan;
    instructions: string;
    title: string;
    markdown: string;
    revision: number;
    updatedAt: number;
    preparationKey?: string;
    pending?: {
        request: WritingRequest;
        /** Only retained to detect unfinished requests from the server-based version. */
        apiUrl?: string;
        target?: import('./JobRouter').JobTarget;
        jobId?: string;
        baseRevision: number;
        history?: FileHistory;
        cancelRequested?: boolean;
    };
    candidate?: { plan?: WritingPlan; title?: string; markdown?: string; history?: FileHistory };
    articleVersions: { title: string; markdown: string; at: number }[];
}

export function historyFingerprint(history: FileHistory): string {
    return createHash('sha256').update(JSON.stringify(history.snapshots)).digest('hex');
}

// One pass over the original character patches; full and empty snapshots are valid.
export function reconstructContents(history: FileHistory): string[] {
    let content: string | undefined;
    return history.snapshots.map((snapshot) => {
        if (snapshot.content !== undefined) content = snapshot.content;
        else if (snapshot.diff && content !== undefined) {
            const patch = snapshot.diff;
            if (patch.start < 0 || patch.end < patch.start || patch.end > content.length) {
                throw new Error('기록의 변경 범위를 복원할 수 없습니다.');
            }
            content = content.slice(0, patch.start) + patch.newText + content.slice(patch.end);
        } else throw new Error('기준 코드를 찾을 수 없습니다. 원본 기록을 확인해 주세요.');
        return content;
    });
}

export function sourceFor(
    history: FileHistory,
    start = 0,
    end = history.snapshots.length - 1,
): WritingSource {
    return buildSource(history, start, end);
}

// Keep original indices and all reviewed plan boundaries. Skipped formatting is
// folded into the next retained diff, so the patch chain still yields finalCode.
export function writingSourceFor(
    history: FileHistory,
    start = 0,
    end = history.snapshots.length - 1,
    boundaries: number[] = [],
): WritingSource {
    return buildSource(history, start, end, new Set([start, end, ...boundaries]));
}

function buildSource(
    history: FileHistory,
    start: number,
    end: number,
    retained?: Set<number>,
): WritingSource {
    if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end < start ||
        end >= history.snapshots.length
    ) {
        throw new Error('글에 사용할 변경 범위를 선택해 주세요.');
    }
    const contents = reconstructContents(history);
    const language = history.language || 'plaintext';
    const initialCode = start > 0 ? contents[start - 1] : '';
    if (retained && [initialCode, ...contents.slice(start, end + 1)].some(code => utf8Bytes(code) > MAX_CODE_BYTES)) {
        throw new InputSizeError('코드 파일은 UTF-8 기준 512KiB 이하여야 합니다. 파일 크기나 선택한 기록을 확인해 주세요.');
    }
    let previous = initialCode, reconstructedBytes = 0;
    const changes: WritingSource['changes'] = [];
    for (let index = start; index <= end; index++) {
        const content = contents[index];
        if (retained && !retained.has(index) && isCosmeticChange(previous, content, language)) continue;
        if (retained && (reconstructedBytes += utf8Bytes(content)) > MAX_RECONSTRUCTED_BYTES) {
            throw new InputSizeError('복원할 기록이 너무 큽니다. 더 짧은 구간을 선택해 주세요.');
        }
        changes.push({
            index,
            at: new Date(history.snapshots[index].timestamp).toISOString(),
            diff: createTwoFilesPatch('before', 'after', previous, content, '', '', { context: 3 }),
        });
        previous = content;
    }
    return {
        fileName: path.basename(history.filePath),
        language,
        initialCode,
        finalCode: contents[end],
        changes,
    };
}

export function newDraft(history: FileHistory): WritingDraft {
    return {
        schemaVersion: 1,
        filePath: history.filePath,
        history: structuredClone(history),
        fingerprint: historyFingerprint(history),
        instructions: '',
        writingStyle: 'plain',
        customStyle: '',
        title: '',
        markdown: '',
        revision: 0,
        updatedAt: Date.now(),
        articleVersions: [],
    };
}

export function preparationSource(history: FileHistory): WritingSource {
    // Keep the UI's complete history. Only bound the material in one model request.
    let start = Math.max(0, history.snapshots.length - MAX_CHANGES);
    const end = history.snapshots.length - 1;
    while (true) {
        try {
            const source = writingSourceFor(history, start, end);
            checkInputSize({ source });
            return source;
        } catch (error) { if (!(error instanceof InputSizeError)) throw error; }
        if (start === end) {
            throw new Error(
                '코드가 한 번에 분석하기에는 너무 큽니다. 512KiB 이하의 파일과 더 짧은 기록 범위를 선택해 주세요.',
            );
        }
        start += Math.max(1, Math.ceil((end - start) / 3));
    }
}

export function validatePlan(value: unknown, count: number, allowEmptyTitle = false): WritingPlan {
    if (!value || typeof value !== 'object') throw new Error('준비 내용을 확인해 주세요.');
    const plan = value as WritingPlan;
    const range = (start: number, end: number) =>
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 &&
        end >= start &&
        end < count;
    const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
    if (
        !text(plan.title, 300) ||
        (!allowEmptyTitle && !plan.title.trim()) ||
        !text(plan.summary, 12000) ||
        !range(plan.start, plan.end) ||
        !Array.isArray(plan.steps) ||
        plan.steps.length > 12 ||
        plan.steps.some(
            (s) =>
                !s ||
                !text(s.title, 300) ||
                !text(s.body, 12000) ||
                !range(s.start, s.end) ||
                (!allowEmptyTitle && (s.start < plan.start || s.end > plan.end)),
        )
    ) {
        throw new Error('설명이나 변경 범위가 올바르지 않습니다.');
    }
    return structuredClone(plan);
}

export function mergeResult(
    draft: WritingDraft,
    result: NonNullable<WritingDraft['candidate']>,
    baseRevision: number,
): void {
    if (result.plan) {
        result = {
            ...result,
            plan: validatePlan(result.plan, (result.history || draft.history).snapshots.length),
        };
    }
    if (draft.revision !== baseRevision) {
        draft.candidate = result;
        return;
    }
    if (result.plan) {
        draft.plan = result.plan;
        if (result.history) {
            draft.history = result.history;
            draft.fingerprint = historyFingerprint(result.history);
        }
    }
    if (typeof result.markdown === 'string' && typeof result.title === 'string') {
        if (draft.markdown) {
            draft.articleVersions = [
                ...draft.articleVersions,
                { title: draft.title, markdown: draft.markdown, at: Date.now() },
            ].slice(-20);
        }
        draft.title = result.title;
        draft.markdown = result.markdown;
    }
    draft.revision++;
    draft.updatedAt = Date.now();
}
