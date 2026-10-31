export const WRITING_STYLES = ['plain', 'formal', 'friendly', 'notes', 'custom'] as const;
export type WritingStyle = typeof WRITING_STYLES[number];
export interface WritingPreferences {
    writingStyle?: WritingStyle;
    customStyle?: string;
    instructions: string;
}

const descriptions = {
    plain: '담백한 했다/이다체로 작성해 주세요.',
    formal: '차분하게 설명하는 합니다체로 작성해 주세요.',
    friendly: '편안하게 설명하는 해요체로 작성해 주세요.',
    notes: '간결한 메모체로 작성해 주세요. 핵심과 이유가 연결되게 짧게 적어 주세요.',
};

// This is author input, sent through WritingRequest.instructions in the user
// message. Never concatenate these preferences into a system prompt.
export function writingInstructions(preferences: WritingPreferences): string {
    const style = preferences.writingStyle ?? 'plain';
    if (!WRITING_STYLES.includes(style)) throw new Error('글의 문체를 선택해 주세요.');
    const description = style === 'custom'
        ? preferences.customStyle?.trim() || descriptions.plain
        : descriptions[style];
    const input = `문체: ${description}` + (preferences.instructions ? `\n\n추가 요청:\n${preferences.instructions}` : '');
    if (input.length > 12000) throw new Error('문체와 추가 요청은 합쳐서 12,000자 이내로 적어 주세요.');
    return input;
}
