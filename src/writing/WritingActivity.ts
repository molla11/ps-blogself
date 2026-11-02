import { createHash } from 'crypto';
import { atomicWrite, observeFile, readJson, withFileLock } from '../storage/SharedFiles';
import { articleVersionKey, WritingDraft, WritingPlan } from './model';

export interface ViewedWriting { notes: string[]; articles: string[] }
export interface WritingActivitySummary {
    notes: number; articles: number; unreadArticles: boolean;
}
export interface WritingActivityContent extends ViewedWriting { newArticles: string[]; visible: ViewedWriting }
const empty = (): ViewedWriting => ({ notes: [], articles: [] });
const normalize = (text: string) => text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').trimEnd();
function noteKeys(plan?: WritingPlan): string[] {
    if (!plan) return [];
    const steps = plan.steps.filter(step => step.end >= plan.start && step.start <= plan.end)
        .map(step => ({ title: normalize(step.title), body: normalize(step.body), start: step.start, end: step.end }));
    if (!plan.summary.trim() && !steps.some(step => step.body.trim())) return [];
    const content = { title: normalize(plan.title), summary: normalize(plan.summary), start: plan.start, end: plan.end, steps };
    return [createHash('sha256').update(JSON.stringify(content)).digest('hex')];
}
export function writingActivityContent(draft?: WritingDraft): WritingActivityContent {
    if (!draft) return { ...empty(), newArticles: [], visible: empty() };
    const article = (value: { title?: string; markdown?: string }) => value.markdown?.trim()
        ? [articleVersionKey({ title: value.title || '', markdown: value.markdown })] : [];
    const visible = { notes: noteKeys(draft.plan), articles: article(draft) };
    const articles = [...new Set([...visible.articles, ...draft.articleVersions.flatMap(article), ...article(draft.candidate || {})])];
    return {
        notes: [...new Set([...visible.notes, ...noteKeys(draft.candidate?.plan)])],
        articles,
        newArticles: articles.filter(key => draft.newArticleKeys?.includes(key)),
        visible,
    };
}

/** Call only when a generation completes, before saving the resulting draft.
 * Edits, restores, and reading older drafts never create notifications. */
export function registerGeneratedArticles(draft: WritingDraft, previousArticles: string[]) {
    const content = writingActivityContent(draft);
    draft.newArticleKeys = content.articles.filter(key => content.newArticles.includes(key) || !previousArticles.includes(key));
}

/** Read receipts are independent of the draft's editing lease. Viewing in another
 * window must never take ownership or conflict with an in-flight draft save. */
export class WritingActivityStore {
    private cache = new Map<string, Promise<WritingActivityContent>>();
    private watchers = new Map<string, { dispose(): void }>();
    private receiptsWatch: { dispose(): void };
    private receipts: Record<string, ViewedWriting> = {};
    private ready: Promise<void>;
    private disposed = false;
    constructor(private file: string,
        private readDraft: (filePath: string) => Promise<WritingDraft | undefined>,
        private watchDraft: (filePath: string, changed: () => void) => { dispose(): void },
        private changed: (filePath: string) => void) {
        this.ready = this.reloadReceipts();
        this.receiptsWatch = observeFile(file, () => { this.ready = this.ready.then(() => this.reloadReceipts()).catch(() => {}); });
    }
    private async reloadReceipts() {
        const next = await readJson<Record<string, ViewedWriting>>(this.file) || {};
        const previous = this.receipts;
        this.receipts = next;
        for (const filePath of new Set([...Object.keys(previous), ...Object.keys(next)])) {
            if (JSON.stringify(previous[filePath]) !== JSON.stringify(next[filePath])) this.changed(filePath);
        }
    }
    update(draft: WritingDraft) {
        const content = writingActivityContent(draft);
        this.cache.set(draft.filePath, Promise.resolve(content));
        return content;
    }
    private async content(filePath: string): Promise<WritingActivityContent> {
        if (!this.watchers.has(filePath) && !this.disposed) {
            this.watchers.set(filePath, this.watchDraft(filePath, () => {
                this.cache.delete(filePath);
                this.changed(filePath);
            }));
        }
        let pending = this.cache.get(filePath);
        if (!pending) {
            pending = this.readDraft(filePath).then(writingActivityContent);
            this.cache.set(filePath, pending);
        }
        try {
            const content = await pending;
            // An edit or another window's save may have replaced this read.
            return this.cache.get(filePath) === pending ? content : this.content(filePath);
        } catch (error) {
            if (this.cache.get(filePath) === pending) this.cache.delete(filePath);
            throw error;
        }
    }
    async summary(filePath: string): Promise<WritingActivitySummary> {
        const [content] = await Promise.all([this.content(filePath), this.ready]);
        const seen = this.receipts[filePath] || empty();
        return { notes: content.notes.length, articles: content.articles.length,
            unreadArticles: content.newArticles.some(key => !seen.articles.includes(key)) };
    }
    async markViewed(filePath: string, viewed: ViewedWriting): Promise<void> {
        if (!viewed.articles.length) return;
        await withFileLock(this.file, async () => {
            const content = writingActivityContent(await this.readDraft(filePath));
            const receipts = await readJson<Record<string, ViewedWriting>>(this.file) || {};
            const previous = receipts[filePath] || empty();
            const next = {
                notes: [],
                articles: [...new Set([...previous.articles, ...viewed.articles.filter(key => content.articles.includes(key))])],
            };
            // Retain old keys while they can still be shown in a saved version.
            next.articles = next.articles.filter(key => content.articles.includes(key));
            if (JSON.stringify(previous) !== JSON.stringify(next)) {
                receipts[filePath] = next;
                await atomicWrite(this.file, receipts);
            }
            this.receipts = receipts;
        });
        this.changed(filePath);
    }
    dispose() {
        this.disposed = true;
        this.receiptsWatch.dispose();
        for (const watcher of this.watchers.values()) watcher.dispose();
        this.watchers.clear(); this.cache.clear();
    }
}
