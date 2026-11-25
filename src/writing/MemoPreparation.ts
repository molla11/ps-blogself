import { diffArrays } from 'diff';

// Heuristics only control automatic requests. Every snapshot remains available for manual preparation.
const words = /[\p{L}_$][\p{L}\p{N}_$]*|\d+(?:\.\d+)?|<<=|>>=|\*\*|\/\/|==|!=|<=|>=|<<|>>|&&|\|\||\+=|-=|\*=|\/=|%=|\+\+|--|\S/gu;
const strings = /"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'/;
const cppTrivia = /^[ \t]*#\s*(?:include|pragma)\b[^\n]*|^[ \t]*using\s+namespace\b[^\n;]*;|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|(?![\s\S]))/;
const pythonTrivia = /^[ \t]*(?:from\s+\S+\s+import|import)\s+[^\n;]*|#[^\n]*/;
const algorithm = /^(?:if|else|elif|while|for|return|break|continue|sort|sorted|min|max|sum|set|map|heapq|deque|queue|stack|bisect|push|pop|insert|append|and|or|in|[+*/%<>-]|<=|>=|==|!=|\+\+|--|\+=|-=|&&|\|\|)$/;
const behaviorOperator = /^(?:if|else|elif|break|continue|return|and|or|not|in|[+*/%<>&|^-]|<<|>>|\*\*|\/\/|<=|>=|==|!=|\+=|-=|&&|\|\||indent|dedent)$/;
const punctuation = /^[(){}\[\],;:.]$/;

function memoTokens(code: string, python: boolean): string[] {
    // Match literals before looking for comments inside them. Keep Python block structure,
    // while treating a consistently reformatted indentation width as the same program.
    const trivia = python ? pythonTrivia : cppTrivia;
    const pythonStrings = /"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))/;
    const patterns = [strings, trivia, words];
    if (python) patterns.unshift(pythonStrings);
    const tokens = new RegExp(patterns.map(pattern => pattern.source).join('|'), 'gmu');
    const result: string[] = [], indents = [0];
    let end = 0, brackets = 0;
    for (const match of code.matchAll(tokens)) {
        const token = match[0];
        if (trivia.test(token) && !/^["']/.test(token)) continue;
        if (python && !brackets) {
            const gap = code.slice(end, match.index);
            if (!result.length || gap.includes('\n')) {
                const whitespace = gap.slice(gap.lastIndexOf('\n') + 1);
                const width = (whitespace.match(/^[ \t]*/)?.[0] || '').replace(/\t/g, '        ').length;
                while (width < indents[indents.length - 1]) { indents.pop(); result.push('dedent'); }
                if (width > indents[indents.length - 1]) { indents.push(width); result.push('indent'); }
            }
        }
        if (python && ['(', '[', '{'].includes(token)) brackets++;
        if (python && [')', ']', '}'].includes(token)) brackets = Math.max(0, brackets - 1);
        result.push(token);
        end = match.index + token.length;
    }
    return result;
}

export function meritsAutomaticMemo(before: string, after: string, language: string): boolean {
    if (before === after || !after.trim()) return false;
    const python = language === 'python' || language === 'py';
    const previous = memoTokens(before, python), current = memoTokens(after, python);
    if (!current.length) return false;
    let from = 0, left = previous.length, right = current.length;
    while (from < left && from < right && previous[from] === current[from]) from++;
    while (left > from && right > from && previous[left - 1] === current[right - 1]) { left--; right--; }
    if (left === from && right === from) return false;
    // Ignore unchanged tokens between separate edits. Bound the work for rewrites.
    const changes = diffArrays(previous.slice(from, left), current.slice(from, right), { maxEditLength: 48 });
    if (!changes) return true;
    const removed = changes.filter(part => part.removed).flatMap(part => part.value.filter(t => !punctuation.test(t)));
    const added = changes.filter(part => part.added).flatMap(part => part.value.filter(t => !punctuation.test(t)));
    const size = Math.max(added.length, removed.length);
    if (!size) return false;
    if (!previous.length) return size >= 14 || (size >= 6 && added.some(t => algorithm.test(t)));
    if (size <= 2 && [...removed, ...added].some(t => t === 'indent' || t === 'dedent')) return true;
    const pair = added.length ? added : removed;
    if (size === 2 && ['+', '-'].includes(pair[0]) && pair[1] === '1'
        && current.slice(Math.max(0, from - 5), from).some(t => ['range', '[', '<', '<=', '>', '>='].includes(t))) return true;
    if (removed.length && added.length && (removed.some(t => behaviorOperator.test(t)) || added.some(t => behaviorOperator.test(t)))) return true;
    if (removed.length === 1 && added.length === 1 && /^(?:return|<|>|<=|>=|==|!=)$/.test(current[from - 1])) return true;
    return size >= 8 || (size >= 3 && [...added, ...removed].some(t => algorithm.test(t)));
}

export const MEMO_COOLDOWN = 3 * 60_000;
const QUIET = 15_000, MAX_WAIT = 90_000;

/** One background job at a time. Keep edits arriving during an in-flight job for the next pass. */
export class MemoPreparationQueue {
    private files = new Map<string, { first: number; due: number; notBefore: number }>();
    private timer?: NodeJS.Timeout;
    private active?: string;
    private stopped = false;
    private generation = 0;

    constructor(private prepare: (file: string) => Promise<number | void>, private finished: (file: string) => void) {}

    schedule(file: string, review = false) {
        if (this.stopped) return;
        const now = Date.now(), previous = this.files.get(file);
        const first = previous?.first ?? now, notBefore = previous?.notBefore ?? 0;
        this.files.set(file, { first, notBefore, due: Math.max(notBefore, review ? now : Math.min(now + QUIET, first + MAX_WAIT)) });
        this.arm();
    }

    private arm() {
        clearTimeout(this.timer);
        if (this.stopped || this.active || !this.files.size) return;
        let next: string | undefined, due = Infinity;
        for (const [file, item] of this.files) if (item.due < due) { next = file; due = item.due; }
        this.timer = setTimeout(() => { void this.run(next!); }, Math.max(0, due - Date.now()));
    }

    private async run(file: string) {
        const generation = this.generation;
        this.active = file;
        this.files.delete(file);
        try {
            const retryAt = await this.prepare(file);
            if (retryAt && generation === this.generation && !this.stopped) {
                const now = Date.now();
                this.files.set(file, { first: now, notBefore: retryAt, due: retryAt });
            }
        } finally {
            this.active = undefined;
            if (!this.stopped) {
                if (!this.files.has(file)) this.finished(file);
                this.arm();
            }
        }
    }

    clear() {
        this.generation++;
        for (const file of this.files.keys()) this.finished(file);
        if (this.active) this.finished(this.active);
        this.files.clear();
        clearTimeout(this.timer);
    }

    dispose() { this.stopped = true; clearTimeout(this.timer); }
}
