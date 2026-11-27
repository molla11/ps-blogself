import { stat } from 'node:fs';
import type { SessionIndexItem } from '../types';

export const filePathKey = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;

type FileRow = { filePath: string; language: string; lastModified?: number };

export class FileModifiedTimes {
    private readonly diskTimes = new Map<string, Promise<number | undefined>>();

    invalidate(filePath: string) {
        this.diskTimes.delete(filePathKey(filePath));
    }

    retain(files: readonly FileRow[]) {
        const current = new Set(files.map(file => filePathKey(file.filePath)));
        for (const key of this.diskTimes.keys()) {
            if (!current.has(key)) this.diskTimes.delete(key);
        }
    }

    private diskTime(filePath: string) {
        const key = filePathKey(filePath);
        let time = this.diskTimes.get(key);
        if (!time) {
            time = new Promise<number | undefined>(resolve => {
                stat(filePath, (error, info) => resolve(error ? undefined : info.mtime.getTime()));
            });
            this.diskTimes.set(key, time);
        }
        return time;
    }

    /** Rank the complete list before the caller takes a preview or a page. */
    async newestFirst<T extends FileRow>(files: readonly T[], history: readonly SessionIndexItem[] = [], isCurrent = () => true) {
        const saved = new Map(history.map(file => [filePathKey(file.filePath), file]));
        const result: (T & { lastModified?: number })[] = [...files];
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(files.length, 32) }, async () => {
            while (next < files.length && isCurrent()) {
                const index = next++;
                const file = files[index];
                if (file.lastModified !== undefined) continue;
                const record = saved.get(filePathKey(file.filePath));
                if (record) {
                    result[index] = { ...file, language: record.language, lastModified: record.lastModified };
                } else {
                    const lastModified = await this.diskTime(file.filePath);
                    if (lastModified !== undefined) result[index] = { ...file, lastModified };
                }
            }
        }));
        if (!isCurrent()) return [];
        return result.sort((a, b) => (b.lastModified ?? -Infinity) - (a.lastModified ?? -Infinity)
            || a.filePath.localeCompare(b.filePath));
    }
}
