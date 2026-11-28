import { isWritingModel, WritingModelAccess } from './WritingModels';
/** Account usage returned by ps-blogself-backend GET /api/me. */
export interface AccountUsage {
    models?: WritingModelAccess[];
    unit: 'credits'; windowSeconds: number; resetsAt?: string;
    hourlyUsedCredits: number; freeHourlyUsedCredits: number; freeHourlyLimitCredits: number; freeRemainingCredits: number;
    creditBalance: number; canStart: boolean; nextFunding: 'free' | 'credit' | null;
    totalUsedCredits: number; todayRequests: number; retryAt: string | null;
}
export interface UsageView { status: 'loading' | 'ready' | 'error'; label: string; paidLabel?: string; resetsAt?: string; detail: string; models?: WritingModelAccess[] }

export function accountUsage(value: unknown): AccountUsage {
    const usage = value as AccountUsage | undefined;
    const amount = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if (!usage || usage.unit !== 'credits'
        || !Number.isSafeInteger(usage.windowSeconds) || usage.windowSeconds <= 0
        || (usage.resetsAt !== undefined && (typeof usage.resetsAt !== 'string' || !Number.isFinite(Date.parse(usage.resetsAt))))
        || !amount(usage.hourlyUsedCredits) || !amount(usage.totalUsedCredits)
        || !amount(usage.freeHourlyUsedCredits) || !amount(usage.freeHourlyLimitCredits) || !amount(usage.freeRemainingCredits)
        || typeof usage.creditBalance !== 'number' || !Number.isFinite(usage.creditBalance)
        || typeof usage.canStart !== 'boolean' || !['free', 'credit', null].includes(usage.nextFunding)
        || !Number.isSafeInteger(usage.todayRequests) || usage.todayRequests < 0
        || !(usage.retryAt === null || (typeof usage.retryAt === 'string' && Number.isFinite(Date.parse(usage.retryAt))))) {
        throw new Error('서버의 사용량 응답을 확인할 수 없습니다. 다시 불러와 주세요.');
    }
    if (usage.models !== undefined && (!Array.isArray(usage.models) || usage.models.some(model =>
        !model || !isWritingModel(model.id) || typeof model.paidOnly !== 'boolean' || typeof model.available !== 'boolean'
        || !['free', 'credit', null].includes(model.nextFunding)))) {
        throw new Error('서버의 모델 사용 가능 여부를 확인할 수 없습니다.');
    }
    return usage;
}

export function usageView(usage: AccountUsage): UsageView {
    const credits = (value: number) => new Intl.NumberFormat('ko-KR', {
        maximumFractionDigits: 0,
    }).format(Math.floor(value));
    const seconds = usage.windowSeconds;
    const [duration, unit] = seconds % 3600 === 0 ? [seconds / 3600, '시간']
        : seconds % 60 === 0 ? [seconds / 60, '분'] : [seconds, '초'];
    const window = `${duration}${unit}`;
    const freeUsed = credits(usage.freeHourlyUsedCredits);
    const freeLimit = credits(usage.freeHourlyLimitCredits);
    const paid = credits(usage.creditBalance);
    const label = `무료 크레딧: ${freeUsed} / ${freeLimit}`;
    const details = [
        `남은 크레딧: 무료 ${credits(usage.freeRemainingCredits)} · 유료 ${paid}`,
        usage.resetsAt ? '무료 크레딧은 계정 접속 시각을 기준으로 1시간마다 초기화됩니다.' : `무료 크레딧은 사용한 만큼이 ${window} 뒤 채워집니다.`,
        usage.canStart
            ? `현재 선택된 모델은 다음 요청에 ${usage.nextFunding === 'credit' ? '유료' : '무료'} 크레딧을 사용합니다.`
            : '지금은 새 요청을 시작할 수 없어요.',
        ...(usage.retryAt ? [`다시 요청 가능 · ${new Date(usage.retryAt).toLocaleString('ko-KR')}`] : []),
        '',
        `${usage.resetsAt ? '이번 시간대' : `최근 ${window}`} 사용 ${credits(usage.hourlyUsedCredits)}크레딧 (무료 ${freeUsed} / ${freeLimit})`,
        `오늘 요청 ${usage.todayRequests.toLocaleString('ko-KR')}회 · 누적 사용 ${credits(usage.totalUsedCredits)}크레딧`,
    ];
    return { status: 'ready', label, paidLabel: `유료 크레딧: ${paid}`, resetsAt: usage.resetsAt, detail: details.join('\n'), ...(usage.models ? { models: usage.models } : {}) };
}
