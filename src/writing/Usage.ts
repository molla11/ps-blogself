/** Account usage returned by ps-blogself-backend GET /api/me. */
export interface AccountUsage {
    unit: 'credits'; windowSeconds: number;
    hourlyUsedCredits: number; freeHourlyUsedCredits: number; freeHourlyLimitCredits: number; freeRemainingCredits: number;
    creditBalance: number; canStart: boolean; nextFunding: 'free' | 'credit' | null;
    totalUsedCredits: number; todayRequests: number; retryAt: string | null;
}
export interface UsageView { status: 'loading' | 'ready' | 'error'; label: string; detail: string }

export function accountUsage(value: unknown): AccountUsage {
    const usage = value as AccountUsage | undefined;
    const amount = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if (!usage || usage.unit !== 'credits'
        || !Number.isSafeInteger(usage.windowSeconds) || usage.windowSeconds <= 0
        || !amount(usage.hourlyUsedCredits) || !amount(usage.totalUsedCredits)
        || !amount(usage.freeHourlyUsedCredits) || !amount(usage.freeHourlyLimitCredits) || !amount(usage.freeRemainingCredits)
        || typeof usage.creditBalance !== 'number' || !Number.isFinite(usage.creditBalance)
        || typeof usage.canStart !== 'boolean' || !['free', 'credit', null].includes(usage.nextFunding)
        || !Number.isSafeInteger(usage.todayRequests) || usage.todayRequests < 0
        || !(usage.retryAt === null || (typeof usage.retryAt === 'string' && Number.isFinite(Date.parse(usage.retryAt))))) {
        throw new Error('서버의 사용량 응답을 확인할 수 없습니다. 다시 불러와 주세요.');
    }
    return usage;
}

export function usageView(usage: AccountUsage): UsageView {
    const credits = (value: number) => new Intl.NumberFormat('ko-KR', {
        maximumFractionDigits: 0,
    }).format(Math.floor(value));
    const seconds = usage.windowSeconds;
    const window = seconds % 3600 === 0 ? `${seconds / 3600}시간` : seconds % 60 === 0 ? `${seconds / 60}분` : `${seconds}초`;
    const label = `최근 ${window} 무료 ${credits(usage.freeHourlyUsedCredits)} / ${credits(usage.freeHourlyLimitCredits)} · 유료 ${credits(usage.creditBalance)}크레딧`;
    const details = [
        `최근 ${window} 전체 사용 ${credits(usage.hourlyUsedCredits)}크레딧`,
        `무료 사용 ${credits(usage.freeHourlyUsedCredits)} / ${credits(usage.freeHourlyLimitCredits)}크레딧 · 남은 무료 ${credits(usage.freeRemainingCredits)}크레딧`,
        `유료 잔액 ${credits(usage.creditBalance)}크레딧`,
        usage.canStart ? `다음 요청: ${usage.nextFunding === 'credit' ? '유료 크레딧' : '무료 크레딧'}` : '현재 새 요청을 시작할 수 없습니다.',
        `누적 사용 ${credits(usage.totalUsedCredits)}크레딧 · 오늘 요청 ${usage.todayRequests.toLocaleString('ko-KR')}회`,
        ...(usage.retryAt ? [`다시 요청 가능: ${new Date(usage.retryAt).toLocaleString('ko-KR')}`] : []),
    ];
    return { status: 'ready', label, detail: details.join('\n') };
}
