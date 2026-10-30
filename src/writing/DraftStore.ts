import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { WritingDraft } from './model';

export class DraftStore {
    private writes = new Map<string, Promise<unknown>>();
    constructor(private directory: string) {}
    private file(filePath: string) {
        return path.join(
            this.directory,
            createHash('sha256').update(filePath).digest('hex') + '.json',
        );
    }
    async read(filePath: string): Promise<WritingDraft | undefined> {
        await this.writes.get(filePath);
        try {
            const draft = JSON.parse(await readFile(this.file(filePath), 'utf8')) as WritingDraft;
            if (
                draft.schemaVersion !== 1 ||
                draft.filePath !== filePath ||
                !draft.history?.snapshots ||
                !Array.isArray(draft.articleVersions)
            ) {
                throw new Error('저장된 글 형식을 확인할 수 없습니다.');
            }
            return draft;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
        }
    }
    save(draft: WritingDraft): Promise<void> {
        const serialized = JSON.stringify(draft);
        const write = (this.writes.get(draft.filePath) || Promise.resolve())
            .catch(() => {})
            .then(async () => {
                await mkdir(this.directory, { recursive: true, mode: 0o700 });
                const file = this.file(draft.filePath);
                const temp = file + '.' + randomUUID() + '.tmp';
                await writeFile(temp, serialized, { mode: 0o600 });
                await rename(temp, file);
            });
        this.writes.set(draft.filePath, write);
        return write;
    }
    async flush() {
        await Promise.all(this.writes.values());
    }
}
