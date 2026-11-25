import * as diff from 'diff';
import { FileHistory } from '../types';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const lineCount = (value: string) => value ? value.split('\n').length - (value.endsWith('\n') ? 1 : 0) : 0;
const yieldToHost = () => new Promise<void>(resolve => setImmediate(resolve));
interface Row { type: 'added' | 'removed' | 'unchanged'; html: string; before?: number; after?: number }

export class HistoryRenderer {
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

    async render(history: FileHistory, index: number, current: string, previous: string, cancelled = () => false) {
        const currentLines = await this.highlight(current, history.language);
        if (cancelled()) return;
        const previousLines = index === 0 ? [] : await this.highlight(previous, history.language);
        if (cancelled()) return;
        const parts = index === 0 ? [{ added: true, removed: false, value: current, count: current ? currentLines.length : 0 }]
            : diff.diffLines(previous, current, { timeout: 20, maxEditLength: 2000 }) ?? [
                { removed: true, added: false, value: previous, count: lineCount(previous) },
                { added: true, removed: false, value: current, count: lineCount(current) },
            ];
        const rows: Row[] = [];
        let before = 0, after = 0, addedLines = 0, removedLines = 0, addedChars = 0, removedChars = 0;
        for (const part of parts) {
            const count = part.count ?? 0;
            if (part.added) { addedLines += count; addedChars += part.value.length; }
            if (part.removed) { removedLines += count; removedChars += part.value.length; }
            for (let j = 0; j < count; j++) {
                if (part.added) rows.push({ type: 'added', html: currentLines[after] ?? '', after: ++after });
                else if (part.removed) rows.push({ type: 'removed', html: previousLines[before] ?? '', before: ++before });
                else rows.push({ type: 'unchanged', html: currentLines[after] ?? '', before: ++before, after: ++after });
                if (rows.length % 512 === 0) { await yieldToHost(); if (cancelled()) return; }
            }
        }
        // Merge context ranges in linear time; retain every changed line.
        const ranges: [number, number][] = [];
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].type !== 'unchanged') {
                const start = Math.max(0, i - 3), end = Math.min(rows.length, i + 4), last = ranges.at(-1);
                if (last && start <= last[1]) last[1] = end;
                else ranges.push([start, end]);
            }
        }
        const chunks: string[] = [];
        let chunk = '', chunkRows = 0;
        const append = (row: string) => {
            if (chunk && (chunkRows >= 40 || chunk.length + row.length > 32 * 1024)) { chunks.push(chunk); chunk = ''; chunkRows = 0; }
            chunk += row; chunkRows++;
        };
        for (const [rangeIndex, [start, end]] of ranges.entries()) {
            if (rangeIndex) append('<tr class="diff-separator"><td>…</td><td>…</td><td>…</td></tr>');
            for (let i = start; i < end; i++) {
                const row = rows[i];
                append(`<tr class="diff-line diff-${row.type}"><td class="diff-line-number">${row.before ?? ''}</td><td class="diff-line-number">${row.after ?? ''}</td><td class="diff-content">${row.html}</td></tr>`);
                if (i % 512 === 511) { await yieldToHost(); if (cancelled()) return; }
            }
        }
        if (!ranges.length) append(`<tr><td colspan="3">${index === 0 ? '빈 파일' : '표시할 변경 내용이 없습니다.'}</td></tr>`);
        if (chunk) chunks.push(chunk);
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
