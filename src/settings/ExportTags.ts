/** Commas separate tags; spaces inside a name are preserved. */
export function normalizeExportTags(value: unknown): string[] {
    const values = typeof value === 'string' ? value.split(',') : value;
    if (!Array.isArray(values) || values.some(tag => typeof tag !== 'string')) throw new Error('태그를 쉼표로 구분해 입력해 주세요.');
    const tags: string[] = [], seen = new Set<string>();
    for (const value of values) {
        const tag = value.trim().normalize('NFC');
        if (!tag) continue;
        if (tag.length > 191 || tag.includes(',') || [...tag].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
            throw new Error('태그는 각각 191자 이내로 입력하고 줄바꿈 없이 쉼표로 구분해 주세요.');
        }
        const key = tag.toLowerCase();
        if (!seen.has(key)) { seen.add(key); tags.push(tag); }
    }
    if (tags.length > 50 || tags.join(', ').length > 4096) throw new Error('태그는 50개, 전체 4,096자 이내로 입력해 주세요.');
    return tags;
}
