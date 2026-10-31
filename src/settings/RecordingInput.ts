/** Extension input accepts either .cpp or cpp; storage and the recorder share one form. */
export function normalizeExtensions(values: unknown): string[] {
    if (!Array.isArray(values) || values.length > 50) throw new Error('대상 확장자를 50개 이하로 입력해 주세요.');
    const result: string[] = [];
    for (const value of values) {
        if (typeof value !== 'string') throw new Error('확장자를 확인해 주세요.');
        const extension = value.trim().replace(/^\./, '').toLowerCase();
        if (!/^[a-z0-9][a-z0-9_+-]{0,19}$/.test(extension)) throw new Error('확장자만 입력해 주세요. 예: .c, .cpp, .py');
        if (!result.includes(extension)) result.push(extension);
    }
    return result;
}
