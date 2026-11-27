import * as diff from 'diff';
import { FileHistory } from '../types';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const lineCount = (value: string) => value ? value.split('\n').length - (value.endsWith('\n') ? 1 : 0) : 0;
const yieldToHost = () => new Promise<void>(resolve => setImmediate(resolve));

function compare(index: number, current: string, previous: string, currentLineCount: number) {
    return index === 0 ? [{ added: true, removed: false, value: current, count: current ? currentLineCount : 0 }]
        : diff.diffLines(previous, current, { timeout: 20, maxEditLength: 2000 }) ?? [
            { removed: true, added: false, value: previous, count: lineCount(previous) },
            { added: true, removed: false, value: current, count: lineCount(current) },
        ];
}

export class HistoryRenderer {
    private previewDiff?: { index: number; current: string; previous: string; parts: ReturnType<typeof compare> };
    private cached?: { code: string; lines: string[] };

    constructor(private readonly colorize = async (code: string, language: string) => {
        const { ShikiService } = await import('./ShikiService.js');
        return ShikiService.getInstance().highlight(code, language);
    }) {}

    private async highlight(code: string, language: string): Promise<string[]> {
        if (this.cached?.code === code) return this.cached.lines;
        let html: string;
        try {
            html = code.length <= 32 * 1024
                ? await this.colorize(code, language)
                : `<pre><code>${escapeHtml(code)}</code></pre>`;
        } catch {
            html = `<pre><code>${escapeHtml(code)}</code></pre>`;
        }
        const lines = (html.match(/<code[^>]*>([\s\S]*?)<\/code>/)?.[1] ?? html).split('\n');
        this.cached = { code, lines };
        return lines;
    }

    async render(history: FileHistory, index: number, current: string, previous: string, cancelled = () => false, preview = false) {
        const lines = (code: string) => preview ? code.split('\n') : this.highlight(code, history.language);
        const currentLines = await lines(current);
        if (cancelled()) return;
        const previousLines = index === 0 ? [] : await lines(previous);
        if (cancelled()) return;
        const first = this.previewDiff;
        const parts = first && first.index === index && first.current === current && first.previous === previous
            ? first.parts : compare(index, current, previous, currentLines.length);
        this.previewDiff = preview ? { index, current, previous, parts } : undefined;
        let addedLines = 0, removedLines = 0, addedChars = 0, removedChars = 0;
        for (const part of parts) {
            if (part.added) { addedLines += part.count ?? 0; addedChars += part.value.length; }
            if (part.removed) { removedLines += part.count ?? 0; removedChars += part.value.length; }
        }
        const chunks: string[] = [];
        let chunk = '', chunkRows = 0;
        const append = (row: string) => {
            if (chunk && (chunkRows >= 40 || chunk.length + row.length > 32 * 1024)) {
                if (preview) return false;
                chunks.push(chunk); chunk = ''; chunkRows = 0;
            }
            chunk += row; chunkRows++;
            return true;
        };
        let before = 0, after = 0;
        partsLoop: for (const [i, part] of parts.entries()) {
            const count = part.count ?? 0;
            const type = part.added ? 'added' : part.removed ? 'removed' : 'unchanged';
            // Show three context lines on either side of a change. Skip hidden lines in one step.
            const head = type !== 'unchanged' ? count : Math.min(i > 0 ? 3 : 0, count);
            const tail = type === 'unchanged' && i + 1 < parts.length ? Math.max(head, count - 3) : count;
            for (let j = 0; j < count;) {
                if (j === head && tail > head) {
                    if (head && tail < count && !append('<tr class="diff-separator"><td>…</td><td>…</td><td>…</td></tr>')) break partsLoop;
                    j = tail;
                    continue;
                }
                const code = (part.removed ? previousLines[before + j] : currentLines[after + j]) ?? '';
                const row = `<tr class="diff-line diff-${type}"><td class="diff-line-number">${part.added ? '' : before + j + 1}</td><td class="diff-line-number">${part.removed ? '' : after + j + 1}</td><td class="diff-content">${preview ? escapeHtml(code) : code}</td></tr>`;
                if (!append(row)) break partsLoop;
                if (++j % 512 === 0) { await yieldToHost(); if (cancelled()) return; }
            }
            if (!part.added) before += count;
            if (!part.removed) after += count;
        }
        if (!chunk) append(`<tr><td colspan="3">${index === 0 ? '빈 파일' : '표시할 변경 내용이 없습니다.'}</td></tr>`);
        chunks.push(chunk);
        const stats = index === 0 ? `<span class="stat-added">+${addedLines}(${addedChars})</span>`
            : `${addedLines ? `<span class="stat-added">+ ${addedLines}(${addedChars})</span>` : ''}${removedLines ? `<span class="stat-removed">- ${removedLines}(${removedChars})</span>` : ''}`;
        const date = new Date(history.snapshots[index].timestamp);
        const html = `<div class="history-entry" data-snapshot-index="${index}">
            <div class="entry-header"><span class="entry-title"><span>v${index + 1}</span>${stats}<time class="stat-date" datetime="${date.toISOString()}">${escapeHtml(date.toLocaleString())}</time></span>
            <div class="entry-actions">${index < history.snapshots.length - 1 ? `<button class="delete-btn" data-index="${index}">로그 삭제</button>` : ''}
            <button class="view-code-btn" data-index="${index}">이 시점의 코드 보기</button></div></div>
            <div class="diff-container"><table class="diff-table"><tbody></tbody></table></div></div>`;
        return { html, chunks };
    }
}
