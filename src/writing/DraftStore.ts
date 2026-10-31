import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { WritingDraft, previousArticleVersions } from './model';
import { atomicWrite, observeFile, readJson, withFileLock } from '../storage/SharedFiles';
import { WindowSession } from '../storage/WindowSession';

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
    async read(filePath: string): Promise<WritingDraft | undefined> {
        const draft = await readJson<WritingDraft>(this.file(filePath));
        if (draft && (draft.schemaVersion !== 1 || draft.filePath !== filePath || !draft.history?.snapshots || !Array.isArray(draft.articleVersions))) {
            throw new Error('저장된 글 형식을 확인할 수 없습니다.');
        }
        if (draft) draft.articleVersions = previousArticleVersions(draft);
        return draft;
    }
    owns(draft: WritingDraft) { return draft.editor?.owner.id === this.session.id; }
    async open(initial: WritingDraft, takeover = false): Promise<WritingDraft> {
        const owner = await this.session.owner();
        return withFileLock(this.file(initial.filePath), async () => {
            const draft = await this.read(initial.filePath) || structuredClone(initial);
            if (this.owns(draft)) return draft;
            if (!takeover && await WindowSession.alive(draft.editor?.owner)) return draft;
            draft.editor = { owner, token: randomUUID() };
            draft.storageVersion = (draft.storageVersion || 0) + 1;
            await atomicWrite(this.file(draft.filePath), draft);
            this.owned.add(draft.filePath);
            return draft;
        });
    }
    save(draft: WritingDraft): Promise<void> {
        const snapshot = structuredClone(draft);
        const write = (this.writes.get(draft.filePath) || Promise.resolve()).catch(() => {}).then(async () => {
            const owner = await this.session.owner();
            await withFileLock(this.file(draft.filePath), async () => {
                const current = await this.read(draft.filePath);
                if ((current?.storageVersion || 0) !== (draft.storageVersion || 0)
                    || (current?.editor && (!this.owns(current) || current.editor.token !== draft.editor?.token))) throw new DraftConflict();
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
            const draft = await this.read(filePath);
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
