export const WRITING_STYLES = ['plain', 'formal', 'friendly', 'notes', 'custom'] as const;
export type WritingStyle = typeof WRITING_STYLES[number];
export const WRITING_MODES = ['evolution', 'solution', 'algorithm'] as const;
export type WritingMode = typeof WRITING_MODES[number];
export interface WritingPreferences {
    writingMode?: WritingMode;
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
const modeDescriptions = {
    evolution: '수정 과정 중심. 중요한 수정의 이전 코드, 문제, 바뀐 코드와 효과가 드러나게 작성해 주세요.',
    solution: '풀이 해설 중심. 현재 코드의 핵심 아이디어와 동작 원리를 중심으로 설명해 주세요.',
    algorithm: '알고리즘 설명 중심. 실제 사용한 알고리즘이나 자료구조의 원리를 설명하고, 이 문제에 어떻게 적용했는지 코드와 연결해 주세요.',
};

// This is author input, sent through WritingRequest.instructions in the user
// message. Never concatenate these preferences into a system prompt.
export function writingInstructions(preferences: WritingPreferences): string {
    const mode = preferences.writingMode ?? 'evolution';
    if (!WRITING_MODES.includes(mode)) throw new Error('글 구성 모드를 선택해 주세요.');
    const style = preferences.writingStyle ?? 'plain';
    if (!WRITING_STYLES.includes(style)) throw new Error('글의 문체를 선택해 주세요.');
    const description = style === 'custom'
        ? preferences.customStyle?.trim() || descriptions.plain
        : descriptions[style];
    const input = `글 구성: ${modeDescriptions[mode]}\n\n문체: ${description}` + (preferences.instructions ? `\n\n추가 요청:\n${preferences.instructions}` : '');
    if (input.length > 12000) throw new Error('글 구성·문체·추가 요청은 합쳐서 12,000자 이내로 적어 주세요.');
    return input;
}
