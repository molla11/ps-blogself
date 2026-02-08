import * as vscode from 'vscode';
import { configManager } from '../config';
import { storageManager } from './StorageManager';

export class FileWatcher {
    private static _instance: FileWatcher;
    private _disposable?: vscode.Disposable;
    private _changeDisposable?: vscode.Disposable;
    private _debounceTimers: Map<string, NodeJS.Timeout> = new Map();

    private constructor() {}

    public static getInstance(): FileWatcher {
        if (!FileWatcher._instance) {
            FileWatcher._instance = new FileWatcher();
        }
        return FileWatcher._instance;
    }

    public init(context: vscode.ExtensionContext) {
        this._disposable = vscode.workspace.onDidSaveTextDocument(this._onDidSaveDocument, this);
        this._changeDisposable = vscode.workspace.onDidChangeTextDocument(
            this._onDidChangeDocument,
            this,
        );
        context.subscriptions.push(this._disposable);
        context.subscriptions.push(this._changeDisposable);
    }

    private _onDidChangeDocument(event: vscode.TextDocumentChangeEvent) {
        const document = event.document;

        // 1. Basic validation
        if (!this._isValidDocument(document)) {
            return;
        }

        // 2. Debounce logic (10 seconds)
        const key = document.uri.toString();

        if (this._debounceTimers.has(key)) {
            clearTimeout(this._debounceTimers.get(key)!);
        }

        const timer = setTimeout(async () => {
            this._debounceTimers.delete(key);
            await storageManager.saveSnapshot(document);
        }, 10000); // 10 seconds debounce

        this._debounceTimers.set(key, timer);
    }

    private async _onDidSaveDocument(document: vscode.TextDocument) {
        if (!this._isValidDocument(document)) {
            return;
        }

        // Cancel pending debounce if manual save happens
        const key = document.uri.toString();
        if (this._debounceTimers.has(key)) {
            clearTimeout(this._debounceTimers.get(key)!);
            this._debounceTimers.delete(key);
        }

        await storageManager.saveSnapshot(document);
    }

    private _isValidDocument(document: vscode.TextDocument): boolean {
        // 1. Check if recording is enabled
        if (!configManager.isRecording()) {
            return false;
        }

        // 2. Check if file is in the tracked root folder
        const rootFolder = configManager.getRootFolder();
        if (rootFolder && !document.fileName.startsWith(rootFolder)) {
            return false;
        }

        // 3. Check language/extension
        const supportedLangs = configManager.getSupportedLanguages();
        const ext = document.fileName.split('.').pop()?.toLowerCase();

        if (!ext || !supportedLangs.includes(ext)) {
            return false;
        }

        return true;
    }
}

export const fileWatcher = FileWatcher.getInstance();
