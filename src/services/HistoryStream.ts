import { FileHistory, SnapshotDiff } from '../types';
import { HistoryRenderer } from './HistoryRenderer';

const yieldToHost = () => new Promise<void>(resolve => setImmediate(resolve));

interface HistoryPair { index: number; current: string; previous: string }

/** Reconstruct only as far back as the next full snapshot needed by the reader. */
export async function* reverseHistory(history: FileHistory, cancelled = () => false): AsyncGenerator<HistoryPair, void> {
    const snapshots = history.snapshots;
    let nextFull: { index: number; content: string } | undefined;
    let deadline = Date.now() + 8;
    for (let end = snapshots.length - 1; end >= 0;) {
        if (cancelled()) return;
        let start = end;
        while (start > 0 && snapshots[start].content === undefined) start--;
        let content = snapshots[start].content;
        if (content === undefined) throw new Error('수정 기록을 복원하지 못했습니다.');
        const undo: SnapshotDiff[] = [];
        for (let i = start + 1; i <= end; i++) {
            const patch = snapshots[i].diff;
            if (!patch || patch.start < 0 || patch.end < patch.start || patch.end > content.length) {
                throw new Error('수정 기록을 복원하지 못했습니다.');
            }
            const { start: from, end: to, newText } = patch;
            undo.push({ start: from, end: from + newText.length, newText: content.slice(from, to) });
            content = content.slice(0, from) + newText + content.slice(to);
            if (Date.now() >= deadline) {
                await yieldToHost();
                if (cancelled()) return;
                deadline = Date.now() + 8;
            }
        }
        if (nextFull) yield { index: nextFull.index, current: nextFull.content, previous: content };
        for (let i = end; i > start; i--) {
            if (cancelled()) return;
            const patch = undo.pop()!;
            const previous: string = content.slice(0, patch.start) + patch.newText + content.slice(patch.end);
            yield { index: i, current: content, previous };
            content = previous;
        }
        nextFull = { index: start, content };
        end = start - 1;
    }
    if (nextFull && !cancelled()) yield { index: 0, current: nextFull.content, previous: '' };
}

/** One entry per acknowledgement. Never render the rest of a closed panel. */
export class HistoryStream {
    private cancelled = false;
    private readonly entries;
    private readonly renderer: HistoryRenderer;
    private first?: HistoryPair;
    private current?: { index: number; html: string; chunks: string[]; cursor: number };

    constructor(private readonly history: FileHistory, renderer = new HistoryRenderer()) {
        this.entries = reverseHistory(history, () => this.cancelled);
        this.renderer = renderer;
    }

    async preview() {
        const entry = await this.entries.next();
        if (entry.done || this.cancelled) return;
        this.first = entry.value;
        const { index, current, previous } = entry.value;
        const rendered = await this.renderer.render(this.history, index, current, previous, () => this.cancelled, true);
        if (rendered && !this.cancelled) return { html: rendered.html, rows: rendered.chunks[0] };
    }

    async next() {
        await yieldToHost();
        if (this.cancelled) return;
        if (!this.current) {
            const entry = this.first ?? (await this.entries.next()).value;
            this.first = undefined;
            if (!entry || this.cancelled) return;
            const { index, current, previous } = entry;
            const rendered = await this.renderer.render(this.history, index, current, previous, () => this.cancelled);
            if (!rendered || this.cancelled) return;
            this.current = { index, ...rendered, cursor: 0 };
        }
        const entry = this.current;
        const html = entry.cursor === 0 ? entry.html : '';
        const rows = entry.chunks[entry.cursor++];
        const complete = entry.cursor === entry.chunks.length;
        if (complete) this.current = undefined;
        return { index: entry.index, html, rows, complete };
    }

    dispose() {
        this.cancelled = true;
        this.current = undefined;
        void this.entries.return(undefined);
    }
}
