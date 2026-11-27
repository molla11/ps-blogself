import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { FileHistory, Snapshot, SnapshotTrigger, RequestLog, SessionIndexItem, SnapshotDiff } from '../types';
import { getHash, generateUUID, computeDiff } from './utils';
import { Logger } from '../services/logger';
import { atomicWrite, observeFile, withFileLock } from './SharedFiles';
import { nextEditBatch, endsEditBatch, sameBurst } from './EditBatch';
import { limitedSnapshotText } from './SnapshotLimit';

interface Capture {
    document: Pick<vscode.TextDocument, 'uri' | 'languageId'>;
    content: string;
    timestamp: number;
    baseline?: string;
    trigger?: SnapshotTrigger;
    editSession?: string;
    undo?: boolean;
    historyWritten?: boolean;
}

export class HistoryConflict extends Error {
    constructor() { super('다른 창에서 수정 기록이 변경되었습니다. 최신 기록을 확인해 주세요.'); }
}

export class StorageManager {
    private static _instance: StorageManager;
    private _globalStorageUri?: vscode.Uri;
    private _saveQueue: Promise<void> = Promise.resolve();
    private readonly failed = new Map<string, Capture[]>();
    private readonly recordingChange = new vscode.EventEmitter<void>();
    readonly onDidChangeRecording = this.recordingChange.event;
    get unsavedSnapshots() { return [...this.failed.values()].reduce((sum, captures) => sum + captures.length, 0); }
    private oversized = new Set<string>();
    private _historyDir?: vscode.Uri;

    private _indexFileUri?: vscode.Uri;
    private historySize?: { version: string; size: Promise<string> };
    private readonly emptyIndex: SessionIndexItem[] = [];
    private verifiedIndex?: { rows: SessionIndexItem[]; directoryVersion: string };
    private indexRead?: { version: string; rows: Promise<SessionIndexItem[]> };
    private _onDidUpdateIndex = new vscode.EventEmitter<void>();
    public readonly onDidUpdateIndex = this._onDidUpdateIndex.event;
    private readonly snapshotSaved = new vscode.EventEmitter<string>();
    public readonly onDidSaveSnapshot = this.snapshotSaved.event;

    private constructor() {}

    public static getInstance(): StorageManager {
        if (!StorageManager._instance) {
            StorageManager._instance = new StorageManager();
        }
        return StorageManager._instance;
    }

    public init(context: vscode.ExtensionContext) {
        this.indexRead = undefined;
        this.verifiedIndex = undefined;
        this.historySize = undefined;
        this._globalStorageUri = context.globalStorageUri;
        // globalStorage/ps-blogself/history/
        this._historyDir = vscode.Uri.joinPath(this._globalStorageUri, 'history');
        // globalStorage/ps-blogself/session-index.json
        this._indexFileUri = vscode.Uri.joinPath(this._globalStorageUri, 'session-index.json');
        context.subscriptions?.push(observeFile(this._indexFileUri.fsPath, () => this._onDidUpdateIndex.fire()));
    }

    private async _ensureStorageInit(): Promise<void> {
        if (!this._historyDir) {
            throw new Error('StorageManager not initialized');
        }
        await fs.mkdir(this._historyDir.fsPath, { recursive: true });
    }

    public reconstructFileContent(
        history: FileHistory,
        targetSnapshotIndex: number,
    ): string | null {
        if (!Number.isInteger(targetSnapshotIndex) || targetSnapshotIndex < 0 || targetSnapshotIndex >= history.snapshots.length) {
            return null;
        }

        // Optimization: if the target snapshot has full content, return it directly
        if (history.snapshots[targetSnapshotIndex].content !== undefined) {
            return history.snapshots[targetSnapshotIndex].content!;
        }

        // Otherwise, we need to find the nearest previous full snapshot
        let content: string | undefined;
        let diffs: SnapshotDiff[] = [];
        let index = targetSnapshotIndex;

        while (index >= 0) {
            const snapshot = history.snapshots[index];
            if (snapshot.content !== undefined) {
                content = snapshot.content;
                break;
            } else if (snapshot.diff) {
                diffs.unshift(snapshot.diff);
            }
            index--;
        }

        if (content === undefined) {
            return null;
        }

        // Apply diffs
        for (const diff of diffs) {
            content = content.substring(0, diff.start) + diff.newText + content.substring(diff.end);
        }

        return content;
    }

    private _getLastSnapshotContent(history: FileHistory): string | null {
        return this.reconstructFileContent(history, history.snapshots.length - 1);
    }

    public saveSnapshot(document: vscode.TextDocument, baseline?: string, trigger?: SnapshotTrigger, editSession?: string, undo = false): Promise<void> {
        const length = typeof document.offsetAt === 'function'
            ? document.offsetAt(new vscode.Position(document.lineCount - 1, Number.MAX_SAFE_INTEGER)) : undefined;
        const content = limitedSnapshotText(length, () => document.getText());
        const key = document.uri.toString();
        if (content === undefined) {
            if (!this.oversized.has(key)) {
                if (this.oversized.size >= 128) this.oversized.delete(this.oversized.values().next().value!);
                this.oversized.add(key);
                void vscode.window.showWarningMessage(`${path.basename(document.uri.fsPath)}: 512KiB를 초과해 수정 기록을 저장하지 않았습니다. 파일 저장과 기존 기록은 유지됩니다.`);
            }
            return Promise.resolve();
        }
        this.oversized.delete(key);
        const capture: Capture = { document: { uri: document.uri, languageId: document.languageId }, content, baseline, trigger, editSession, undo, timestamp: Date.now() };
        const write = this._saveQueue.then(() => this.writeCaptures(capture.document.uri.fsPath, capture));
        this._saveQueue = write.catch(() => {});
        return write;
    }

    private async writeCaptures(key: string, capture?: Capture) {
        const pending = this.failed.get(key) ?? [];
        if (capture) pending.push(capture);
        try {
            await withFileLock(this._indexFileUri!.fsPath, async () => {
                while (pending.length) {
                    await this._saveSnapshot(pending[0]);
                    pending.shift();
                }
            });
            if (this.failed.delete(key)) this.recordingChange.fire();
        } catch (error) {
            this.failed.set(key, pending);
            this.recordingChange.fire();
            throw error;
        }
    }

    public flush(filePath?: string): Promise<void> {
        const write = this._saveQueue.then(async () => {
            let failure: unknown;
            for (const key of [...this.failed.keys()]) {
                if (filePath && key !== filePath) continue;
                try { await this.writeCaptures(key); } catch (error) { failure = error; }
            }
            if (failure) throw failure;
        });
        this._saveQueue = write.catch(() => {});
        return write;
    }

    public async installSampleHistory(): Promise<string> {
        if (!this._globalStorageUri) throw new Error('저장 공간을 준비하지 못했습니다.');
        const filePath = path.join(this._globalStorageUri.fsPath, 'samples', '샘플-중복제거.py');
        const write = this._saveQueue.then(() => withFileLock(this._indexFileUri!.fsPath, async () => {
            await this._ensureStorageInit();
            const hash = getHash(filePath);
            const historyPath = path.join(this._historyDir!.fsPath, hash + '.json');
            try { await fs.access(historyPath); return; } catch { /* First use only. */ }
            const versions = [
                'def unique_numbers(numbers):\n    result = []\n    for number in numbers:\n        if number not in result:\n            result.append(number)\n    return result\n',
                'def unique_numbers(numbers):\n    return list(set(numbers))\n',
                'def unique_numbers(numbers):\n    seen = set()\n    result = []\n    for number in numbers:\n        if number not in seen:\n            seen.add(number)\n            result.append(number)\n    return result\n',
                'def unique_numbers(numbers):\n    return list(dict.fromkeys(numbers))\n\nassert unique_numbers([3, 1, 3, 2, 1]) == [3, 1, 2]\nassert unique_numbers([]) == []\n',
            ];
            const now = Date.now();
            const history: FileHistory = { id: generateUUID(), filePath, language: 'python', startedAt: now - 180000, lastModified: now, requestLogs: [], snapshots: versions.map((content, i) => ({ content, timestamp: now - (3 - i) * 60000, hash: getHash(content) })) };
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, versions[3]);
            await atomicWrite(historyPath, history);
            await this._updateSessionIndex({ uri: vscode.Uri.file(filePath), languageId: 'python' } as vscode.TextDocument, now, hash);
        }));
        this._saveQueue = write.catch(() => {});
        await write;
        return filePath;
    }

    private async _saveSnapshot(capture: Capture): Promise<void> {
        if (!this._historyDir) throw new Error('기록 저장 공간이 준비되지 않았습니다.');
        const { document, content, baseline, trigger, timestamp } = capture;
        const absolutePath = document.uri.fsPath;
        const fileHash = getHash(absolutePath);
        const historyFileUri = vscode.Uri.joinPath(this._historyDir, `${fileHash}.json`);

        const contentHash = getHash(content);

        try {
            await this._ensureStorageInit();

            let history: FileHistory;

            // Load existing history
            try {
                const existingData = await fs.readFile(historyFileUri.fsPath, 'utf-8');
                history = JSON.parse(existingData);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                // Create new history
                history = {
                    id: generateUUID(),
                    filePath: absolutePath,
                    language: document.languageId,
                    memoBaseline: baseline === content ? null : baseline,
                    startedAt: timestamp,
                    lastModified: timestamp,
                    snapshots: [],
                    requestLogs: [],
                };
            }

            const marker = historyFileUri.fsPath + '.unindexed';
            const finishIndex = async () => {
                await this._updateSessionIndex(document, history.lastModified, fileHash);
                await fs.rm(marker, { force: true });
                this.snapshotSaved.fire(absolutePath);
            };
            if (capture.historyWritten) {
                await finishIndex();
                return;
            }
            const checkpoint = trigger === 'save' || trigger === 'run' || trigger === 'debug' || trigger === 'task' ? trigger : undefined;
            // Execution identifies an existing saved version. An unsaved buffer may differ from what ran.
            if (checkpoint && checkpoint !== 'save' && history.snapshots.at(-1)?.hash !== contentHash) return;

            const last = history.snapshots.at(-1);
            if (last?.hash === contentHash) {
                const mark = checkpoint && !last.checkpoints?.includes(checkpoint);
                const seal = history.openEdit && (endsEditBatch(trigger) || history.openEdit.session !== capture.editSession);
                if (mark) (last.checkpoints ??= []).push(checkpoint);
                if (seal) delete history.openEdit;
                if (mark || seal) await atomicWrite(historyFileUri.fsPath, history);
                return;
            }

            const before = last ? this._getLastSnapshotContent(history) : baseline ?? null;
            const delta = before !== null ? computeDiff(before, content) : null;
            const batch = nextEditBatch(history, last, before, content, delta, capture.editSession, trigger, timestamp);
            // Ctrl+Z can discard the exact unreviewed addition. The saved hash verifies
            // the editor's Undo without retaining a copy of the intermediate text.
            const undidInsertion = capture.undo && !endsEditBatch(trigger) && history.openEdit?.beforeInsertHash === contentHash
                && sameBurst(history, last, capture.editSession, timestamp);
            const amend = (!!batch && batch.count > 1) || !!undidInsertion;
            const index = history.snapshots.length - Number(amend);
            const parent = history.snapshots[index - 1];
            if (amend && parent?.hash === contentHash) {
                // The burst returned to the version already on disk.
                history.snapshots.pop();
                if (checkpoint && !parent.checkpoints?.includes(checkpoint)) (parent.checkpoints ??= []).push(checkpoint);
                delete history.openEdit;
            } else {
                let patch = delta;
                if (index % 128 === 0) patch = null;
                else if (amend) {
                    const base = this.reconstructFileContent(history, index - 1);
                    if (base === null) throw new Error('수정 기록의 기준 코드를 복원하지 못했습니다.');
                    patch = computeDiff(base, content);
                }
                const snapshot: Snapshot = { timestamp, hash: contentHash, trigger, ...(patch ? { diff: patch } : { content }) };
                // A manual save within the burst still counts as a save checkpoint for memo preparation.
                if (checkpoint) snapshot.checkpoints = [checkpoint];
                else if (amend && last?.checkpoints?.includes('save')) snapshot.checkpoints = ['save'];
                history.snapshots[index] = snapshot;
                history.openEdit = batch && !undidInsertion ? { ...batch, index, hash: contentHash } : undefined;
            }
            history.lastModified = timestamp;

            // An interrupted history/index pair is repaired when opening the full list.
            await fs.writeFile(marker, '', { mode: 0o600 });
            await atomicWrite(historyFileUri.fsPath, history);
            Logger.info(`[StorageManager] Saved snapshot for ${absolutePath}`);

            capture.historyWritten = true;
            await finishIndex();
        } catch (error) {
            Logger.error(`[StorageManager] Failed to save snapshot for ${absolutePath}:`, error);
            throw error;
        }
    }

    private async _updateSessionIndex(
        document: Pick<vscode.TextDocument, 'uri' | 'languageId'>,
        timestamp: number,
        fileHash: string,
    ) {
        if (!this._indexFileUri) {
            return;
        }

        let index: SessionIndexItem[] = [];
        try {
            const indexData = await fs.readFile(this._indexFileUri.fsPath, 'utf-8');
            index = this.parseIndex(indexData);
        } catch (error) {
            if (error instanceof SyntaxError || error instanceof TypeError) {
                // The history was committed under this lock. Reconstruct the index from it.
                await this.repairIndex(this._historyDir!.fsPath, this._indexFileUri.fsPath);
                return;
            }
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }

        const absolutePath = document.uri.fsPath;

        // Remove existing entry for this file
        index = index.filter((item) => item.filePath !== absolutePath);

        // Add new entry at top
        const newItem: SessionIndexItem = {
            filePath: absolutePath,
            fileName: path.basename(absolutePath),
            language: document.languageId,
            lastModified: timestamp,
            fileHash: fileHash,
        };

        index.unshift(newItem);
        if (index[1]?.lastModified > timestamp) index.sort((a, b) => b.lastModified - a.lastModified);

        await atomicWrite(this._indexFileUri.fsPath, index);

        // Notify listeners
        this._onDidUpdateIndex.fire();
    }

    private parseIndex(data: string): SessionIndexItem[] {
        const index = JSON.parse(data);
        if (!Array.isArray(index) || !index.every(item => item && typeof item.filePath === 'string'
            && typeof item.fileName === 'string' && typeof item.language === 'string'
            && Number.isFinite(item.lastModified) && typeof item.fileHash === 'string')) throw new TypeError('Invalid session index');
        return index;
    }

    public async getRecentFiles(): Promise<SessionIndexItem[]> {
        await this._saveQueue;
        if (!this._indexFileUri) return this.emptyIndex;
        const file = this._indexFileUri.fsPath;
        try {
            // Atomic replacements in other windows must be visible even before the watcher fires.
            const info = await fs.stat(file, { bigint: true });
            const version = `${info.ino}:${info.ctimeNs}:${info.size}`;
            if (this.indexRead?.version !== version) {
                const rows = fs.readFile(file, 'utf8').then(data => this.parseIndex(data));
                this.indexRead = { version, rows };
            }
            return await this.indexRead.rows;
        } catch {
            this.indexRead = undefined;
            return this.emptyIndex;
        }
    }

    public async getAllLogs(): Promise<SessionIndexItem[]> {
        if (!this._historyDir) return [];
        const index = await this.getRecentFiles();
        let names: string[], directoryVersion: string;
        try {
            const info = await fs.stat(this._historyDir.fsPath, { bigint: true });
            directoryVersion = `${info.ino}:${info.ctimeNs}:${info.mtimeNs}`;
            if (this.verifiedIndex?.rows === index && this.verifiedIndex.directoryVersion === directoryVersion) return index;
            names = await fs.readdir(this._historyDir.fsPath);
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
        const hashes = new Set(names.filter(name => /^[0-9a-f]{64}\.json$/.test(name)).map(name => name.slice(0, -5)));
        if (this.indexRead && hashes.size === index.length && index.every(row => hashes.delete(row.fileHash) && row.fileHash === getHash(row.filePath))
            && !names.some(name => name.endsWith('.unindexed'))) {
            this.verifiedIndex = { rows: index, directoryVersion };
            return index;
        }
        await this.rebuildIndex();
        return this.getRecentFiles();
    }

    public async rebuildIndex(): Promise<void> {
        if (!this._indexFileUri || !this._historyDir) return;
        const directory = this._historyDir.fsPath, file = this._indexFileUri.fsPath;
        await this._saveQueue;
        await withFileLock(file, () => this.repairIndex(directory, file));
    }

    private async repairIndex(directory: string, file: string) {
        await this._ensureStorageInit();
        const names = await fs.readdir(directory);
        const index: SessionIndexItem[] = [];
        for (const name of names.filter(name => /^[0-9a-f]{64}\.json$/.test(name))) {
            try {
                const history: FileHistory = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
                const { filePath, language, lastModified } = history;
                if (getHash(filePath) === name.slice(0, -5)) index.push({ filePath, fileName: path.basename(filePath), language, lastModified, fileHash: name.slice(0, -5) });
            } catch (error) {
                if (!(error instanceof SyntaxError)) throw error;
                Logger.error(`[StorageManager] Failed to read ${name} during rebuild`, error);
            }
        }
        await atomicWrite(file, index.sort((a, b) => b.lastModified - a.lastModified));
        for (const name of names.filter(name => /^[0-9a-f]{64}\.json\.unindexed$/.test(name))) await fs.rm(path.join(directory, name), { force: true });
        this._onDidUpdateIndex.fire();
    }

    public async addRequestLog(
        document: vscode.TextDocument,
        promptType: string,
        snapshotIndexRange: [number, number],
    ): Promise<void> {
        if (!this._indexFileUri) return;
        await withFileLock(this._indexFileUri.fsPath, () => this._addRequestLog(document, promptType, snapshotIndexRange));
    }

    private async _addRequestLog(
        document: vscode.TextDocument,
        promptType: string,
        snapshotIndexRange: [number, number],
    ): Promise<void> {
        if (!this._historyDir) {
            return;
        }

        const absolutePath = document.uri.fsPath;
        const fileHash = getHash(absolutePath);
        const historyFileUri = vscode.Uri.joinPath(this._historyDir, `${fileHash}.json`);

        try {
            const existingData = await fs.readFile(historyFileUri.fsPath, 'utf-8');
            const history: FileHistory = JSON.parse(existingData);

            const newLog: RequestLog = {
                id: generateUUID(),
                timestamp: Date.now(),
                snapshotIndexRange,
                promptType,
            };

            delete history.openEdit;
            history.requestLogs.push(newLog);
            await atomicWrite(historyFileUri.fsPath, history);
            Logger.info(`[StorageManager] Added request log for ${absolutePath}`);
        } catch (error) {
            Logger.error(`[StorageManager] Failed to add request log:`, error);
        }
    }

    public async calculateTotalSize(): Promise<string> {
        if (!this._historyDir) {
            return '0 KB';
        }

        const directory = this._historyDir.fsPath;
        try {
            // History writes replace their files atomically, updating the directory timestamp.
            const info = await fs.stat(directory, { bigint: true });
            const version = `${info.ino}:${info.ctimeNs}:${info.mtimeNs}`;
            if (this.historySize?.version !== version) {
                this.historySize = { version, size: this.readHistorySize(directory) };
            }
            return await this.historySize.size;
        } catch (error) {
            this.historySize = undefined;
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '0.0 KB';
            Logger.error('[StorageManager] Failed to calculate size:', error);
            return 'Error';
        }
    }

    private async readHistorySize(directory: string) {
        const files = (await fs.readdir(directory)).filter(file => file.endsWith('.json'));
        let next = 0, totalBytes = 0;
        await Promise.all(Array.from({ length: Math.min(files.length, 8) }, async () => {
            while (next < files.length) {
                const file = files[next++];
                try { const stats = await fs.stat(path.join(directory, file)); totalBytes += stats.size; }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            }
        }));
        return totalBytes < 1024 * 1024 ? `${(totalBytes / 1024).toFixed(1)} KB`
            : `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    public async getFileHistory(absolutePath: string): Promise<FileHistory | null> {
        await this._saveQueue;
        if (!this._historyDir) return null;
        const file = vscode.Uri.joinPath(this._historyDir, getHash(absolutePath) + '.json').fsPath;
        const read = async (): Promise<FileHistory | null> => {
            try { return JSON.parse(await fs.readFile(file, 'utf-8')); }
            catch { return null; }
        };
        const current = await read();
        if (!current?.openEdit) return current;
        // Once a reader keeps an index, any later saves (including in another window)
        // must append. Re-read while holding the same lock as the recorder.
        return withFileLock(this._indexFileUri!.fsPath, async () => {
            const latest = await read();
            if (latest?.openEdit) {
                delete latest.openEdit;
                await atomicWrite(file, latest);
            }
            return latest;
        });
    }

    public deleteSnapshot(filePath: string, index: number, expectedVersion: string): Promise<void> {
        const write = this._saveQueue.then(() => withFileLock(this._indexFileUri!.fsPath, () => this._deleteSnapshot(filePath, index, expectedVersion)));
        this._saveQueue = write.catch(() => {});
        return write;
    }

    private async _deleteSnapshot(filePath: string, index: number, expectedVersion: string): Promise<void> {
        if (!this._historyDir) {
            return;
        }

        const fileHash = getHash(filePath);
        const historyFileUri = vscode.Uri.joinPath(this._historyDir, `${fileHash}.json`);
        let history: FileHistory;

        if (index < 0) {
            Logger.warn('[StorageManager] Invalid snapshot index for deletion');
            return;
        }

        try {
            const existingData = await fs.readFile(historyFileUri.fsPath, 'utf-8');
            history = JSON.parse(existingData);
        } catch (error) {
            Logger.error('[StorageManager] Failed to load history for deletion:', error);
            return;
        }

        if (getHash(JSON.stringify(history.snapshots)) !== expectedVersion) throw new HistoryConflict();

        if (index >= history.snapshots.length) {
            Logger.warn('[StorageManager] Invalid snapshot index for deletion');
            return;
        }

        // Enhancement: Prevent deleting the last log
        if (index === history.snapshots.length - 1) {
            Logger.warn('[StorageManager] Cannot delete the most recent snapshot');
            return;
        }

        if (index === 0) {
            // Deleting the root.
            if (history.snapshots.length > 1) {
                // The next one (index 1) becomes the new root (index 0).
                const nextSnapshotContent = this.reconstructFileContent(history, 1);

                if (nextSnapshotContent !== null) {
                    history.memoBaseline = null;
                    history.snapshots.splice(0, 1); // Delete index 0
                    // Now index 0 is the old index 1.
                    history.snapshots[0].content = nextSnapshotContent;
                    delete history.snapshots[0].diff;
                } else {
                    Logger.error('[StorageManager] Failed to reconstruct next snapshot content.');
                    return;
                }
            } else {
                // Deleting the only snapshot - blocked by last log check usually, but safe fallback
                history.snapshots = [];
            }
        } else {
            // Deleting a middle node S_i.
            // S_{i-1} -> S_i -> S_{i+1}

            // 1. Get Content of S_{i-1} (Base)
            const prevContent = this.reconstructFileContent(history, index - 1);
            // 2. Get Content of S_{i+1} (Target)
            const nextContent = this.reconstructFileContent(history, index + 1);

            if (prevContent !== null && nextContent !== null) {
                // 3. Update S_{i+1}
                // We are removing S_i at `index`.
                history.snapshots.splice(index, 1);

                // NOW S_{i+1} is at `index` (shifted down).
                // Use recursive cleanup
                this._updateAndCleanup(history, index, prevContent, nextContent);
            } else {
                Logger.error('[StorageManager] Failed to reconstruct content for middle deletion.');
                return;
            }
        }

        delete history.openEdit;
        history.lastModified = Date.now();

        await atomicWrite(historyFileUri.fsPath, history);
        await this._updateSessionIndex({ uri: vscode.Uri.file(filePath), languageId: history.language } as vscode.TextDocument, history.lastModified, fileHash);
        Logger.info(`[StorageManager] Deleted snapshot at index ${index} for ${filePath}`);
    }

    private _updateAndCleanup(
        history: FileHistory,
        index: number,
        prevContent: string,
        currentContent: string,
    ) {
        if (prevContent === currentContent) {
            // The content is identical to previous one. This snapshot is redundant.
            // UNLESS it is the last snapshot. We must preserve the last snapshot state.
            if (index === history.snapshots.length - 1) {
                // It's the last one. We cannot delete it.
                // But since it's identical, it effectively has an empty diff or no change.
                const newDiff = computeDiff(prevContent, currentContent);
                if (newDiff) {
                    history.snapshots[index].diff = newDiff;
                    delete history.snapshots[index].content;
                } else {
                    history.snapshots[index].content = currentContent;
                    delete history.snapshots[index].diff;
                }
            } else {
                // It's a middle one and it's redundant. Delete it!
                history.snapshots.splice(index, 1);

                // Now at 'index' we have the NEXT one (was S_{i+2}).
                // We need to cleanup that one too against prevContent (which is still effective base).
                if (index < history.snapshots.length) {
                    const nextNodeContent = this.reconstructFileContent(history, index);
                    if (nextNodeContent !== null) {
                        this._updateAndCleanup(history, index, prevContent, nextNodeContent);
                    }
                }
            }
        } else {
            // Not identical. Calculate diff and update.
            const targetSnapshot = history.snapshots[index];
            const newDiff = computeDiff(prevContent, currentContent);

            if (newDiff) {
                targetSnapshot.diff = newDiff;
                delete targetSnapshot.content;
            } else {
                targetSnapshot.content = currentContent;
                delete targetSnapshot.diff;
            }
        }
    }
}

export const storageManager = StorageManager.getInstance();
