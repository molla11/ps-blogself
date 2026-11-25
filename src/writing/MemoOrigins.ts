import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { WritingDraft, WritingRequest, WritingStep } from './model';

export interface MemoEdit { field: string; aiText: string }
export interface MemoOriginals {
    title: string;
    summary: string;
    steps: Record<string, Pick<WritingStep, 'title' | 'body'>>;
}

// Only the host attaches identities to a newly generated batch. The editable
// plan carries the identity, while the original text stays in draft storage.
export function rememberAiSteps(steps: WritingStep[], originals: MemoOriginals['steps']) {
    for (const step of steps) {
        const id = randomUUID();
        originals[id] = { title: step.title, body: step.body };
        step.aiStepId = id;
    }
}

export function articleRequestPlan(draft: WritingDraft): WritingRequest['plan'] {
    const { plan, memoOriginals } = draft;
    if (!plan) return;
    const edits: MemoEdit[] = [];
    if (memoOriginals) {
        if (plan.title.trim() && plan.title.trim() !== memoOriginals.title.trim()) {
            edits.push({ field: 'title', aiText: memoOriginals.title });
        }
        if (plan.summary !== memoOriginals.summary) edits.push({ field: 'summary', aiText: memoOriginals.summary });
    }
    const steps = plan.steps.filter(step => step.end >= plan.start && step.start <= plan.end).map((step, index) => {
        if (memoOriginals) {
            const original = step.aiStepId && Object.hasOwn(memoOriginals.steps, step.aiStepId) ? memoOriginals.steps[step.aiStepId] : undefined;
            for (const key of ['title', 'body'] as const) {
                // A note inserted by the author starts with two empty fields.
                const aiText = original?.[key] ?? '';
                if (step[key] !== aiText) edits.push({ field: `steps[${index}].${key}`, aiText });
            }
        }
        return { title: step.title, body: step.body, start: Math.max(step.start, plan.start), end: Math.min(step.end, plan.end) };
    });
    return {
        title: plan.title.trim() || basename(draft.filePath) + ' 풀이 기록',
        summary: plan.summary, start: plan.start, end: plan.end, steps,
        ...(memoOriginals ? { edits } : {}),
    };
}
