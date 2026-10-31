import { WritingPlan, WritingRequest, validatePlan } from './model';
import { checkInputSize, MAX_CHANGES } from './InputLimits';
import { selectedWritingModel } from './WritingModels';

export function validateSourcePlan(value: unknown, request: WritingRequest): WritingPlan {
    const indices = new Set(request.source.changes.map((change) => change.index));
    const plan = validatePlan(value, request.source.changes.at(-1)!.index + 1);
    if (![plan, ...plan.steps].every((step) => indices.has(step.start) && indices.has(step.end))) {
        throw new Error('추천 범위가 기록과 맞지 않습니다. 다시 분석해 주세요.');
    }
    return plan;
}
export function validateRequest(request: WritingRequest): void {
    selectedWritingModel(request.model);
    const source = request.source;
    if (!['prepare_blog', 'write_blog'].includes(request.kind) ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(request.requestId) ||
        typeof request.instructions !== 'string' || request.instructions.length > 12000 ||
        !source || typeof source.fileName !== 'string' || !source.fileName || source.fileName.length > 300 ||
        typeof source.language !== 'string' || source.language.length > 100 ||
        typeof source.initialCode !== 'string' ||
        typeof source.finalCode !== 'string' ||
        !Array.isArray(source.changes) || !source.changes.length || source.changes.length > MAX_CHANGES ||
        source.changes.some((change, index) => !Number.isSafeInteger(change.index) || change.index < 0 ||
            (index > 0 && change.index <= source.changes[index - 1].index) ||
            typeof change.diff !== 'string')) {
        throw new Error('분석할 기록이나 범위를 확인해 주세요. 큰 기록은 범위를 줄여 주세요.');
    }
    checkInputSize(request);
    if (request.plan) validateSourcePlan(request.plan, request);
    if (request.kind === 'write_blog' && (!request.plan ||
        request.plan.start !== source.changes[0].index || request.plan.end !== source.changes.at(-1)!.index)) {
        throw new Error('글에 사용할 구간과 설명을 먼저 준비해 주세요.');
    }
}
