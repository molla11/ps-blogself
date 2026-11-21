import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { getHash } from './utils';
import type { FileHistory } from '../types';

export async function readSavedFileHistory(filePath: string, language: string): Promise<FileHistory> {
    const file = await fs.open(filePath, 'r');
    try {
        const { mtime } = await file.stat();
        const content = await vscode.workspace.decode(await file.readFile(), { uri: vscode.Uri.file(filePath) });
        const timestamp = mtime.getTime();
        return {
            id: getHash(filePath), filePath, language, startedAt: timestamp, lastModified: timestamp,
            snapshots: [{ content, timestamp, hash: getHash(content) }], requestLogs: [],
        };
    } finally {
        await file.close();
    }
}
