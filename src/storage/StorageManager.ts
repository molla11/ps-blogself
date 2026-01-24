import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { FileHistory, Snapshot, RequestLog, SessionIndexItem } from './types';
import { getHash, generateUUID } from './utils';
import { Logger } from '../services/logger';

export class StorageManager {
    private static _instance: StorageManager;
    private _globalStorageUri?: vscode.Uri;
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

    public async saveSnapshot(document: vscode.TextDocument): Promise<void> {
        if (!this._historyDir) {
            console.warn('StorageManager not initialized');
            return;
        }

        const absolutePath = document.uri.fsPath;
        const fileHash = getHash(absolutePath);
        const historyFileUri = vscode.Uri.joinPath(this._historyDir, `${fileHash}.json`);

        const content = document.getText();
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
            if (history.snapshots.length > 0) {
                const lastSnapshot = history.snapshots[history.snapshots.length - 1];
                if (lastSnapshot.hash === contentHash) {
                    return; // No change
                }
            }

            // Add snapshot
            history.snapshots.push({
                timestamp,
                content,
                hash: contentHash,
            });
            history.lastModified = timestamp;

            // Save history file
            await fs.writeFile(historyFileUri.fsPath, JSON.stringify(history, null, 2), 'utf-8');
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
            // Index doesn't exist yet
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

        // Limit index size to 20 (User request)
        if (index.length > 20) {
            index = index.slice(0, 20);
        }

        await fs.writeFile(this._indexFileUri.fsPath, JSON.stringify(index, null, 2), 'utf-8');

        // Notify listeners
        this._onDidUpdateIndex.fire();
    }

    public async getRecentFiles(): Promise<SessionIndexItem[]> {
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

    public async addRequestLog(
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
            await fs.writeFile(historyFileUri.fsPath, JSON.stringify(history, null, 2), 'utf-8');
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
}

export const storageManager = StorageManager.getInstance();
