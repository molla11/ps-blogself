import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { FileHistory, Snapshot, RequestLog, SessionIndexItem, SnapshotDiff } from '../types';
import { getHash, generateUUID, computeDiff } from './utils';
import { Logger } from '../services/logger';
import { atomicWrite, observeFile, withFileLock } from './SharedFiles';

export class HistoryConflict extends Error {
    constructor() { super('다른 창에서 수정 기록이 변경되었습니다. 최신 기록을 확인해 주세요.'); }
}

export class StorageManager {
    private static _instance: StorageManager;
    private _globalStorageUri?: vscode.Uri;
    private _saveQueue: Promise<void> = Promise.resolve();
    private _historyDir?: vscode.Uri;

    private _indexFileUri?: vscode.Uri;
    private _onDidUpdateIndex = new vscode.EventEmitter<void>();
    public readonly onDidUpdateIndex = this._onDidUpdateIndex.event;

    private constructor() {}

    public static getInstance(): StorageManager {
        if (!StorageManager._instance) {
            StorageManager._instance = new StorageManager();
        }
        return StorageManager._instance;
    }

    public init(context: vscode.ExtensionContext) {
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
        try {
            await fs.mkdir(this._historyDir.fsPath, { recursive: true });
        } catch (error) {
            // Context might prevent mkdir if parent doesn't exist, but recursive true handles it
        }
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

    public saveSnapshot(document: vscode.TextDocument): Promise<void> {
        const content = document.getText();
        const write = this._saveQueue.then(() => withFileLock(this._indexFileUri!.fsPath, () => this._saveSnapshot(document, content)));
        this._saveQueue = write.catch(() => {});
        return write;
    }

    public async flush(): Promise<void> {
        await this._saveQueue;
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

    private async _saveSnapshot(document: vscode.TextDocument, content: string): Promise<void> {
        if (!this._historyDir) {
            console.warn('StorageManager not initialized');
            return;
        }

        const absolutePath = document.uri.fsPath;
        const fileHash = getHash(absolutePath);
        const historyFileUri = vscode.Uri.joinPath(this._historyDir, `${fileHash}.json`);

        const contentHash = getHash(content);
        const timestamp = Date.now();

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
                    startedAt: timestamp,
                    lastModified: timestamp,
                    snapshots: [],
                    requestLogs: [],
                };
            }

            // Check content change
            let lastContent: string | null = null;
            if (history.snapshots.length > 0) {
                const lastSnapshot = history.snapshots[history.snapshots.length - 1];
                if (lastSnapshot.hash === contentHash) {
                    return; // No change
                }
                lastContent = this._getLastSnapshotContent(history);
            }

            // Determine snapshot type (Full vs Diff)
            let newSnapshot: Snapshot = {
                timestamp,
                hash: contentHash,
            };

            if (lastContent !== null) {
                const diff = computeDiff(lastContent, content);
                if (diff) {
                    newSnapshot.diff = diff;
                } else {
                    newSnapshot.content = content;
                }
            } else {
                newSnapshot.content = content;
            }

            // Add snapshot
            history.snapshots.push(newSnapshot);
            history.lastModified = timestamp;

            // Save history file
            await atomicWrite(historyFileUri.fsPath, history);
            Logger.info(`[StorageManager] Saved snapshot for ${absolutePath}`);

            // Update Session Index
            await this._updateSessionIndex(document, timestamp, fileHash);
        } catch (error) {
            Logger.error(`[StorageManager] Failed to save snapshot for ${absolutePath}:`, error);
        }
    }

    private async _updateSessionIndex(
        document: vscode.TextDocument,
        timestamp: number,
        fileHash: string,
    ) {
        if (!this._indexFileUri) {
            return;
        }

        let index: SessionIndexItem[] = [];
        try {
            const indexData = await fs.readFile(this._indexFileUri.fsPath, 'utf-8');
            index = JSON.parse(indexData);
        } catch (error) {
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

        // Limit index size to 20 (User request) -> REMOVED to support Full Log View
        // if (index.length > 20) {
        //     index = index.slice(0, 20);
        // }

        await atomicWrite(this._indexFileUri.fsPath, index);

        // Notify listeners
        this._onDidUpdateIndex.fire();
    }

    public async getRecentFiles(): Promise<SessionIndexItem[]> {
        await this._saveQueue;
        if (!this._indexFileUri) {
            return [];
        }
        try {
            const indexData = await fs.readFile(this._indexFileUri.fsPath, 'utf-8');
            return JSON.parse(indexData);
        } catch (error) {
            return [];
        }
    }

    public async getAllLogs(): Promise<SessionIndexItem[]> {
        await this.rebuildIndex(); // Ensure index is up to date with all files
        return this.getRecentFiles(); // Now returns all
    }

    public async rebuildIndex(): Promise<void> {
        if (!this._indexFileUri) return;
        await this._saveQueue;
        await withFileLock(this._indexFileUri.fsPath, () => this._rebuildIndex());
    }

    private async _rebuildIndex(): Promise<void> {
        if (!this._historyDir || !this._indexFileUri) return;

        try {
            const files = await fs.readdir(this._historyDir.fsPath);
            const index: SessionIndexItem[] = [];

            for (const file of files) {
                if (!file.endsWith('.json')) continue;

                try {
                    const filePath = path.join(this._historyDir.fsPath, file);
                    const content = await fs.readFile(filePath, 'utf-8');
                    const history: FileHistory = JSON.parse(content);

                    // Skip request logs if only creating file index?
                    // FileHistory has snapshots.

                    if (history.filePath) {
                        index.push({
                            filePath: history.filePath,
                            fileName: path.basename(history.filePath),
                            language: history.language,
                            lastModified: history.lastModified,
                            fileHash: getHash(history.filePath), // Re-calculate or use history.id? history doesn't store hash of path usually on top level?
                            // In saveSnapshot: const fileHash = getHash(absolutePath);
                            // historyFileUri is named by fileHash.json.
                            // So fileHash is path.basename(file, '.json')
                        });
                    }
                } catch (e) {
                    Logger.error(`[StorageManager] Failed to read ${file} during rebuild`, e);
                }
            }

            // Sort by lastModified desc
            index.sort((a, b) => b.lastModified - a.lastModified);

            await atomicWrite(this._indexFileUri.fsPath, index);
        } catch (error) {
            Logger.error('[StorageManager] Failed to rebuild index:', error);
        }
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

        try {
            await this._ensureStorageInit();
            const files = await fs.readdir(this._historyDir.fsPath);
            let totalBytes = 0;

            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                const filePath = path.join(this._historyDir.fsPath, file);
                const stats = await fs.stat(filePath);
                totalBytes += stats.size;
            }

            if (totalBytes < 1024 * 1024) {
                return `${(totalBytes / 1024).toFixed(1)} KB`;
            } else {
                return `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
            }
        } catch (error) {
            Logger.error('[StorageManager] Failed to calculate size:', error);
            return 'Error';
        }
    }

    public async getFileHistory(absolutePath: string): Promise<FileHistory | null> {
        await this._saveQueue;
        if (!this._historyDir) {
            return null;
        }

        const fileHash = getHash(absolutePath);
        const historyFileUri = vscode.Uri.joinPath(this._historyDir, `${fileHash}.json`);

        try {
            const existingData = await fs.readFile(historyFileUri.fsPath, 'utf-8');
            return JSON.parse(existingData);
        } catch (error) {
            return null;
        }
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
