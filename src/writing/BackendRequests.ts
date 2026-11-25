// One signal covers every backend request in this extension host, including open streams.
let controller = new AbortController();

export const backendRequests = {
    get enabled() { return !controller.signal.aborted; },
    setEnabled(enabled: boolean) {
        if (enabled === this.enabled) return;
        if (enabled) controller = new AbortController();
        else controller.abort(new Error('대회 모드에서 온라인 요청을 차단했습니다.'));
    },
    requireEnabled() { controller.signal.throwIfAborted(); },
    async fetch(input: Parameters<typeof fetch>[0], init: RequestInit = {}) {
        controller.signal.throwIfAborted();
        const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
        return fetch(input, { ...init, signal });
    },
};
