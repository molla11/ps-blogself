import { FileHistory, SnapshotDiff } from '../types';
import { HistoryRenderer } from './HistoryRenderer';

const yieldToHost = () => new Promise<void>(resolve => setImmediate(resolve));

/** Build reversible patches once, rather than reconstructing every prefix twice. */
export async function* reverseHistory(history: FileHistory, cancelled = () => false) {
    const undo: (string | SnapshotDiff)[] = [];
    let content = '', deadline = Date.now() + 8;
    for (const [index, snapshot] of history.snapshots.entries()) {
        if (cancelled()) return;
        if (snapshot.content !== undefined) {
            undo.push(content);
            content = snapshot.content;
        } else if (snapshot.diff && index > 0) {
            const { start, end, newText } = snapshot.diff;
            if (start < 0 || end < start || end > content.length) throw new Error('수정 기록을 복원하지 못했습니다.');
            undo.push({ start, end: start + newText.length, newText: content.slice(start, end) });
            content = content.slice(0, start) + newText + content.slice(end);
        } else throw new Error('수정 기록을 복원하지 못했습니다.');
        if (Date.now() >= deadline) {
            await yieldToHost();
            deadline = Date.now() + 8;
        }
    }
    for (let index = history.snapshots.length - 1; index >= 0; index--) {
        if (cancelled()) return;
        const patch = undo.pop()!;
        const previous = typeof patch === 'string' ? patch
            : content.slice(0, patch.start) + patch.newText + content.slice(patch.end);
        yield { index, current: content, previous };
        content = previous;
    }
}

/** One entry per acknowledgement. Never render the rest of a closed panel. */
export class HistoryStream {
    private cancelled = false;
    private readonly entries;
    private readonly renderer: HistoryRenderer;
    private current?: { index: number; html: string; chunks: string[]; cursor: number };

    constructor(private readonly history: FileHistory, renderer = new HistoryRenderer()) {
        this.entries = reverseHistory(history, () => this.cancelled);
        this.renderer = renderer;
    }

    async next() {
        await yieldToHost();
        if (this.cancelled) return;
        if (!this.current) {
            const entry = await this.entries.next();
            if (entry.done || this.cancelled) return;
            const { index, current, previous } = entry.value;
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
        void this.entries.return();
    }
}
