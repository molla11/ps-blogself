export const WRITING_MODELS = ['standard', 'standard-high', 'opus5.5', 'astra'] as const;
export type WritingModel = typeof WRITING_MODELS[number];
export const DEFAULT_WRITING_MODEL: WritingModel = 'standard-high';
export function isWritingModel(value: unknown): value is WritingModel {
    return typeof value === 'string' && WRITING_MODELS.includes(value as WritingModel);
}
export function selectedWritingModel(value?: WritingModel): WritingModel {
    if (value === undefined) return DEFAULT_WRITING_MODEL;
    if (!isWritingModel(value)) throw new Error('사용할 모델을 선택해 주세요.');
    return value;
}
export interface WritingModelAccess {
    id: WritingModel;
    paidOnly: boolean;
    available: boolean;
    nextFunding: 'free' | 'credit' | null;
}
