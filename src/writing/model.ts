import { ArticleDocument } from './ArticleDocument';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { createTwoFilesPatch } from 'diff';
import { FileHistory } from '../types';
import { meritsAutomaticMemo } from './MemoPreparation';
import { isCosmeticChange } from './ChangeFilter';
import { type MemoOriginals, type MemoEdit, rememberAiSteps } from './MemoOrigins';
import { WritingPreferences } from './WritingStyle';
import { DEFAULT_WRITING_MODEL, WritingModel } from './WritingModels';
import { checkInputSize, MAX_CHANGES, MAX_CODE_BYTES, MAX_RECONSTRUCTED_BYTES, InputSizeError, utf8Bytes } from './InputLimits';

export interface WritingStep {
    /** Local identity of the generated note, retained when other notes are inserted or removed. */
    aiStepId?: string;
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
    changes: { index: number; at: string; diff: string; checkpoint?: boolean }[];
    initialCode: string;
    finalCode: string;
}
export interface WritingRequest {
    model?: WritingModel;
    kind: 'prepare_blog' | 'write_blog';
    supportsAuthorNotices?: boolean;
    requestId: string;
    source: WritingSource;
    plan?: WritingPlan & { edits?: MemoEdit[] };
    instructions: string;
    priority?: 'interactive' | 'prefetch';
}
export interface AuthorNotice {
    source: 'code' | 'plan';
    title: string;
    detail: string;
    appliedFix: string;
}

// Notices are optional metadata. A malformed notice must never cost the author their generated draft.
export function resultNotices(value: unknown): AuthorNotice[] {
    const notices: AuthorNotice[] = [];
    if (!Array.isArray(value)) return notices;
    for (const item of value) {
        if (!item || (item.source !== 'code' && item.source !== 'plan') ||
            typeof item.title !== 'string' || !item.title.trim() || item.title.trim().length > 200 ||
            typeof item.detail !== 'string' || item.detail.length > 2000 ||
            typeof item.appliedFix !== 'string' || item.appliedFix.length > 1000) continue;
        notices.push({ source: item.source, title: item.title.trim(), detail: item.detail, appliedFix: item.appliedFix });
        if (notices.length === 3) break;
    }
    return notices;
}

export interface WritingJob {
    model?: WritingModel;
    id: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    progress: number;
    error?: string;
    errorCode?: string;
    result?: { plan?: WritingPlan; title?: string; markdown?: string; notices?: AuthorNotice[] };
    partial?: string;
}
export type ArticleOrigin = import('./JobRouter').JobTarget & { jobId: string };
export interface ArticleVersion {
    publicationId?: string;
    articleOrigin?: ArticleOrigin;
    title: string;
    markdown: string;
    document?: ArticleDocument;
    at: number;
    notices?: AuthorNotice[];
}
export interface WritingDraft extends WritingPreferences {
    publicationId?: string;
    lastArticleEditAt?: number;
    /** UUID of the last queued edit, or local when it was saved without a matching account. */
    syncEditId?: string;
    syncLabel?: string;
    hasSyncFailures?: boolean;
    articleOrigin?: ArticleOrigin;
    writingModel?: WritingModel;
    schemaVersion: 1;
    storageVersion?: number;
    editor?: { owner: import('../storage/WindowSession').SessionOwner; token: string };
    filePath: string;
    history: FileHistory;
    /** Writing started from the saved source before the recorder had a snapshot. */
    fromSavedFile?: boolean;
    fingerprint: string;
    plan?: WritingPlan;
    instructions: string;
    title: string;
    markdown: string;
    document?: ArticleDocument;
    revision: number;
    updatedAt: number;
    preparationKey?: string;
    lastPreparation?: { index: number; hash: string; at: number };
    preparedPlanHash?: string;
    memoOriginals?: MemoOriginals;
    declinedMemo?: { historyId: string; hash: string; timestamp: number };
    pending?: {
        request: WritingRequest;
        /** Retained only to detect unfinished requests from an older client. */
        apiUrl?: string;
        target?: import('./JobRouter').JobTarget;
        jobId?: string;
        baseRevision: number;
        history?: FileHistory;
        cancelRequested?: boolean;
        append?: boolean;
    };
    candidate?: { publicationId?: string; articleOrigin?: ArticleOrigin; plan?: WritingPlan; title?: string; markdown?: string; document?: ArticleDocument; history?: FileHistory; notices?: AuthorNotice[] };
    planNotices?: AuthorNotice[];
    articleNotices?: AuthorNotice[];
    articleVersions: ArticleVersion[];
    /** Only newly generated articles opt into unread notifications. Legacy drafts have none. */
    newArticleKeys?: string[];
}

// Compare without changing the stored text: indentation and spaces within a line
// still matter, but line endings, trailing spaces and final newlines do not.
export function articleVersionKey(article: Pick<ArticleVersion, 'title' | 'markdown'>): string {
    const normalize = (text: string) => text.replace(/\r\n?/g, '\n')
        .split('\n').map(line => line.trimEnd()).join('\n').trimEnd();
    return createHash('sha256').update(JSON.stringify([normalize(article.title), normalize(article.markdown)])).digest('hex');
}

export function previousArticleVersions(draft: WritingDraft): ArticleVersion[] {
    const seen = new Set([articleVersionKey(draft)]);
    return draft.articleVersions.slice().reverse().filter(version => {
        const key = articleVersionKey(version);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 20).reverse();
}

export function historyFingerprint(history: FileHistory): string {
    return createHash('sha256').update(JSON.stringify(history.snapshots)).digest('hex');
}

// One pass over the original character patches; full and empty snapshots are valid.
export function reconstructContents(history: FileHistory): string[] {
    return [...snapshotContents(history, 0, history.snapshots.length - 1)];
}

function* snapshotContents(history: FileHistory, start: number, end: number): Generator<string, void> {
    let anchor = start;
    while (anchor > 0 && history.snapshots[anchor].content === undefined) anchor--;
    let content: string | undefined;
    for (let index = anchor; index <= end; index++) {
        const snapshot = history.snapshots[index];
        if (snapshot.content !== undefined) content = snapshot.content;
        else if (snapshot.diff && content !== undefined) {
            const patch = snapshot.diff;
            if (patch.start < 0 || patch.end < patch.start || patch.end > content.length) {
                throw new Error('기록의 변경 범위를 복원할 수 없습니다.');
            }
            content = content.slice(0, patch.start) + patch.newText + content.slice(patch.end);
        } else throw new Error('기준 코드를 찾을 수 없습니다. 원본 기록을 확인해 주세요.');
        if (index >= start) yield content;
    }
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
    automatic = false,
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
    const contents = snapshotContents(history, Math.max(0, start - 1), end);
    const language = history.language || 'plaintext';
    const initialCode = start > 0 ? contents.next().value as string : retained ? history.memoBaseline ?? '' : '';
    if (retained && utf8Bytes(initialCode) > MAX_CODE_BYTES) {
        throw new InputSizeError('코드 파일은 UTF-8 기준 512KiB 이하여야 합니다. 파일 크기나 선택한 기록을 확인해 주세요.');
    }
    let previous = initialCode, reconstructedBytes = 0;
    let lastKept = start;
    const changes: WritingSource['changes'] = [];
    for (let index = start; index <= end; index++) {
        const content = contents.next().value as string;
        if (retained && utf8Bytes(content) > MAX_CODE_BYTES) {
            throw new InputSizeError('코드 파일은 UTF-8 기준 512KiB 이하여야 합니다. 파일 크기나 선택한 기록을 확인해 주세요.');
        }
        if (retained && !retained.has(index)) {
            if (automatic && !history.snapshots[index].checkpoints?.length) {
                const time = history.snapshots[index].timestamp;
                const quiet = history.snapshots[index + 1].timestamp - time >= 15_000;
                const longBatch = time - history.snapshots[lastKept].timestamp >= 90_000;
                if ((!quiet && !longBatch) || !meritsAutomaticMemo(previous, content, language)) continue;
            } else if (!automatic && isCosmeticChange(previous, content, language)) continue;
        }
        lastKept = index;
        if (retained && (reconstructedBytes += utf8Bytes(content)) > MAX_RECONSTRUCTED_BYTES) {
            throw new InputSizeError('복원할 기록이 너무 큽니다. 더 짧은 구간을 선택해 주세요.');
        }
        changes.push({
            index,
            ...(automatic && history.snapshots[index].checkpoints?.length ? { checkpoint: true } : {}),
            at: new Date(history.snapshots[index].timestamp).toISOString(),
            diff: createTwoFilesPatch('before', 'after', previous, content, '', '', { context: 3 }),
        });
        previous = content;
    }
    return {
        fileName: path.basename(history.filePath),
        language,
        initialCode,
        finalCode: previous,
        changes,
    };
}

export function newDraft(history: FileHistory): WritingDraft {
    return {
        schemaVersion: 1,
        publicationId: randomUUID(),
        filePath: history.filePath,
        history: structuredClone(history),
        fingerprint: historyFingerprint(history),
        instructions: '',
        writingModel: DEFAULT_WRITING_MODEL,
        writingMode: 'evolution',
        writingStyle: 'plain',
        customStyle: '',
        title: '',
        markdown: '',
        revision: 0,
        updatedAt: Date.now(),
        articleVersions: [],
    };
}

export function preparationSource(history: FileHistory, automatic = false, tailStart = 0): WritingSource {
    // Keep the UI's complete history. Only bound the material in one model request.
    let start = tailStart || Math.max(0, history.snapshots.length - MAX_CHANGES);
    let end = history.snapshots.length - 1;
    while (true) {
        try {
            const source = buildSource(history, start, end, new Set([start, end]), automatic);
            checkInputSize({ source });
            return source;
        } catch (error) { if (!(error instanceof InputSizeError)) throw error; }
        if (start === end) {
            throw new Error(
                '코드가 한 번에 분석하기에는 너무 큽니다. 512KiB 이하의 파일과 더 짧은 기록 범위를 선택해 주세요.',
            );
        }
        const trim = Math.max(1, Math.ceil((end - start) / 3));
        if (tailStart) end -= trim;
        else start += trim;
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

// A revert can repeat a content hash. Match the saved occurrence, even if a
// deletion moved its index, and never attach notes to a newly created history.
export function memoSnapshotIndex(old: FileHistory, current: FileHistory, index: number): number {
    const snapshot = old.snapshots[index];
    if (!snapshot || old.id !== current.id) return -1;
    const same = (s?: typeof snapshot) => s?.hash === snapshot.hash && s.timestamp === snapshot.timestamp;
    return same(current.snapshots[index]) ? index : current.snapshots.findIndex(s => same(s));
}

export function memoTailStart(draft: WritingDraft, history: FileHistory): number | undefined {
    if (!draft.plan) return 0;
    const end = memoSnapshotIndex(draft.history, history, draft.history.snapshots.length - 1);
    if (end < 0 || draft.plan.steps.length >= 12) return;
    const ranges = [draft.plan, ...draft.plan.steps];
    if (ranges.some(r => memoSnapshotIndex(draft.history, history, r.start) < 0 || memoSnapshotIndex(draft.history, history, r.end) < 0)) return;
    return end + 1;
}

export function appendMemoResult(draft: WritingDraft, history: FileHistory, result: WritingPlan, notices?: AuthorNotice[]) {
    const start = memoTailStart(draft, history), plan = draft.plan;
    if (!plan || start === undefined) return false;
    const tail = validatePlan(result, history.snapshots.length);
    if (tail.start < start || tail.end < start) throw new Error('새 메모 구간이 기존 기록과 겹칩니다.');
    const remap = (i: number) => memoSnapshotIndex(draft.history, history, i);
    const steps = plan.steps.map(step => ({ ...step, start: remap(step.start), end: remap(step.end) }));
    // Group the remainder into its own note if this batch would exceed the editable step limit.
    const notes = tail.steps.length ? tail.steps : [{ title: tail.title, body: tail.summary, start: tail.start, end: tail.end }];
    const space = 12 - steps.length;
    if (notes.length > space) {
        const rest = notes.splice(space - 1);
        notes.push({ title: tail.title, body: tail.summary, start: Math.min(...rest.map(n => n.start)), end: Math.max(...rest.map(n => n.end)) });
    }
    if (draft.memoOriginals) {
        // Drop originals for deleted notes before recording the new batch.
        const kept = new Set(steps.map(step => step.aiStepId));
        const originals = Object.fromEntries(Object.entries(draft.memoOriginals.steps).filter(([id]) => kept.has(id)));
        rememberAiSteps(notes, originals);
        draft.memoOriginals = { ...draft.memoOriginals, steps: originals };
    }
    const followEnd = plan.end === draft.history.snapshots.length - 1;
    draft.plan = { ...plan, start: remap(plan.start), end: followEnd ? tail.end : remap(plan.end), steps: [...steps, ...notes] };
    draft.history = history;
    draft.fingerprint = historyFingerprint(history);
    draft.planNotices = resultNotices(notices);
    draft.revision++;
    draft.updatedAt = Date.now();
    return true;
}

function planFingerprint(plan: WritingPlan): string {
    const steps = plan.steps.map(step => [step.start, step.end, step.title, step.body]);
    return createHash('sha256').update(JSON.stringify([plan.start, plan.end, plan.title, plan.summary, steps])).digest('hex');
}

export function preparationBaseRevision(draft: WritingDraft, automatic: boolean): number {
    if (!draft.plan || (automatic && planFingerprint(draft.plan) === draft.preparedPlanHash)) return draft.revision;
    // Regeneration of an edited or legacy plan needs the author's explicit acceptance.
    return -1;
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
    const notices = resultNotices(result.notices);
    if (draft.revision !== baseRevision) {
        draft.candidate = { ...result, notices };
        return;
    }
    if (result.plan) {
        draft.memoOriginals = { title: result.plan.title, summary: result.plan.summary, steps: {} };
        rememberAiSteps(result.plan.steps, draft.memoOriginals.steps);
        draft.plan = result.plan;
        draft.planNotices = notices;
        draft.preparedPlanHash = planFingerprint(result.plan);
        if (result.history) {
            draft.history = result.history;
            draft.fingerprint = historyFingerprint(result.history);
        }
    }
    if (typeof result.markdown === 'string' && typeof result.title === 'string') {
        if (articleVersionKey(draft) !== articleVersionKey({ title: result.title, markdown: result.markdown })) {
            if (draft.markdown.trim()) {
                draft.articleVersions.push({ publicationId: draft.publicationId, articleOrigin: draft.articleOrigin, title: draft.title, markdown: draft.markdown, document: draft.document, notices: draft.articleNotices, at: Date.now() });
            }
            draft.title = result.title;
            draft.markdown = result.markdown;
            draft.document = result.document;
        }
        draft.publicationId = result.publicationId ?? randomUUID();
        draft.articleOrigin = result.articleOrigin;
        delete draft.syncEditId;
        delete draft.syncLabel;
        delete draft.hasSyncFailures;
        draft.articleNotices = notices;
        draft.articleVersions = previousArticleVersions(draft);
    }
    draft.revision++;
    draft.updatedAt = Date.now();
}
