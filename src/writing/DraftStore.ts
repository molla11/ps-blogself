import * as path from 'path';
import { access, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'crypto';
import { ArticleOrigin, ArticleVersion, WritingDraft, previousArticleVersions } from './model';
import { atomicWrite, observeFile, readJson, withFileLock } from '../storage/SharedFiles';
import { WindowSession } from '../storage/WindowSession';
import { separateArticleTitle } from './ArticleContent';

export interface PendingArticleEdit extends Pick<ArticleVersion, 'title' | 'markdown' | 'document'> {
    origin: ArticleOrigin; id: string; editedAt: number;
}
type StoredDraft = WritingDraft & { pendingArticleEdits?: PendingArticleEdit[] };

export class DraftConflict extends Error {
    constructor() { super('다른 창에서 글이 변경되었습니다. 최신 내용을 확인한 뒤 이 창에서 편집해 주세요.'); }
}
export class DraftStore {
    private writes = new Map<string, Promise<unknown>>();
    private owned = new Set<string>();
    constructor(private directory: string, readonly session = new WindowSession()) {}
    private file(filePath: string) {
        return path.join(this.directory, createHash('sha256').update(filePath).digest('hex') + '.json');
    }
    async exists(filePath: string) {
        return access(this.file(filePath)).then(() => true, () => false);
    }
    private async readStored(filePath: string) {
        const draft = await readJson<StoredDraft>(this.file(filePath));
        if (draft && (draft.schemaVersion !== 1 || draft.filePath !== filePath || !draft.history?.snapshots || !Array.isArray(draft.articleVersions))) {
            throw new Error('저장된 글 형식을 확인할 수 없습니다.');
        }
        if (draft) {
            Object.assign(draft, separateArticleTitle(draft));
            draft.articleVersions = draft.articleVersions.map(separateArticleTitle);
            if (draft.candidate) draft.candidate = separateArticleTitle(draft.candidate);
            draft.articleVersions = previousArticleVersions(draft);
        }
        return draft;
    }
    async read(filePath: string): Promise<WritingDraft | undefined> {
        const draft = await this.readStored(filePath);
        if (draft) delete draft.pendingArticleEdits;
        return draft;
    }
    async pendingFiles(): Promise<string[]> {
        let names: string[];
        try { names = await readdir(this.directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
        const pending: string[] = [];
        for (const name of names.filter(name => /^[0-9a-f]{64}\.json$/.test(name))) {
            const file = path.join(this.directory, name);
            try {
                const draft = await readJson<StoredDraft>(file);
                if (draft?.pendingArticleEdits?.length && typeof draft.filePath === 'string' && this.file(draft.filePath) === file) {
                    pending.push(draft.filePath);
                }
            } catch (error) {
                // A damaged draft must not prevent unrelated drafts from syncing.
                if (!(error instanceof SyntaxError)) throw error;
            }
        }
        return pending;
    }
    async pendingEdits(filePath: string) {
        return (await readJson<StoredDraft>(this.file(filePath)))?.pendingArticleEdits ?? [];
    }
    async acknowledgeEdits(filePath: string, ids: Set<string>) {
        const file = this.file(filePath);
        await withFileLock(file, async () => {
            const draft = await readJson<StoredDraft>(file);
            if (!draft?.pendingArticleEdits?.some(edit => ids.has(edit.id))) return;
            draft.pendingArticleEdits = draft.pendingArticleEdits.filter(edit => !ids.has(edit.id));
            if (!draft.pendingArticleEdits.length) delete draft.pendingArticleEdits;
            // Only queue acknowledgements changed. Keep the editor's revision and lease.
            await atomicWrite(file, draft);
        });
    }
    owns(draft: WritingDraft) { return draft.editor?.owner.id === this.session.id; }
    async open(initial: WritingDraft, takeover = false): Promise<WritingDraft> {
        const owner = await this.session.owner();
        return withFileLock(this.file(initial.filePath), async () => {
            const draft: StoredDraft = await this.readStored(initial.filePath) || structuredClone(initial);
            if (!this.owns(draft) && (takeover || !await WindowSession.alive(draft.editor?.owner))) {
                draft.editor = { owner, token: randomUUID() };
                draft.storageVersion = (draft.storageVersion || 0) + 1;
                await atomicWrite(this.file(draft.filePath), draft);
                this.owned.add(draft.filePath);
            }
            delete draft.pendingArticleEdits;
            return draft;
        });
    }
    save(draft: WritingDraft, edit?: PendingArticleEdit): Promise<void> {
        const snapshot: StoredDraft = structuredClone(draft);
        const write = (this.writes.get(draft.filePath) || Promise.resolve()).catch(() => {}).then(async () => {
            const owner = await this.session.owner();
            await withFileLock(this.file(draft.filePath), async () => {
                const current = await this.readStored(draft.filePath);
                if ((current?.storageVersion || 0) !== (draft.storageVersion || 0)
                    || (current?.editor && (!this.owns(current) || current.editor.token !== draft.editor?.token))) throw new DraftConflict();
                const pending = current?.pendingArticleEdits ?? [];
                if (edit) pending.push(edit);
                if (pending.length) snapshot.pendingArticleEdits = pending;
                else delete snapshot.pendingArticleEdits;
                snapshot.editor = current?.editor || { owner, token: randomUUID() };
                snapshot.storageVersion = (current?.storageVersion || 0) + 1;
                await atomicWrite(this.file(draft.filePath), snapshot);
                draft.storageVersion = snapshot.storageVersion;
                draft.editor = snapshot.editor;
                this.owned.add(draft.filePath);
            });
        });
        this.writes.set(draft.filePath, write);
        void write.finally(() => { if (this.writes.get(draft.filePath) === write) this.writes.delete(draft.filePath); }).catch(() => {});
        return write;
    }
    watch(filePath: string, changed: () => void) { return observeFile(this.file(filePath), changed); }
    async release(filePath: string) {
        await withFileLock(this.file(filePath), async () => {
            const draft = await this.readStored(filePath);
            if (draft && this.owns(draft)) {
                delete draft.editor;
                draft.storageVersion = (draft.storageVersion || 0) + 1;
                await atomicWrite(this.file(filePath), draft);
            }
            this.owned.delete(filePath);
        });
    }
    async flush() { await Promise.all(this.writes.values()); }
    async close() {
        try {
            await this.flush();
        } finally {
            try { await Promise.all([...this.owned].map(file => this.release(file))); }
            finally { await this.session.close(); }
        }
    }
}
