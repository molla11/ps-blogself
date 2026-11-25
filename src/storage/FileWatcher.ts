import * as vscode from 'vscode';
import * as path from 'path';
import { configManager } from '../config';
import { storageManager } from './StorageManager';
import { BackgroundRecorder } from './BackgroundRecorder';
import { limitedSnapshotText } from './SnapshotLimit';
import { Logger } from '../services/logger';

export class FileWatcher {
    private static _instance: FileWatcher;
    private readonly saveReasons = new WeakMap<vscode.TextDocument, vscode.TextDocumentSaveReason>();
    private readonly baselines = new WeakMap<vscode.TextDocument, string>();
    private readonly pending = new BackgroundRecorder<vscode.TextDocument>(async document => {
        if (this._isValidDocument(document)) {
            try { await storageManager.saveSnapshot(document, this.baselines.get(document)); }
            catch (error) { Logger.error('수정 기록을 저장하지 못했습니다.', error); }
        }
    });

    private constructor() {}

    public static getInstance(): FileWatcher {
        if (!FileWatcher._instance) {
            FileWatcher._instance = new FileWatcher();
        }
        return FileWatcher._instance;
    }

    public init(context: vscode.ExtensionContext) {
        let active = vscode.window.activeTextEditor?.document;
        const rememberBaseline = (doc: vscode.TextDocument) => {
            if (!this._isValidDocument(doc)) { this.baselines.delete(doc); return; }
            if (this.baselines.has(doc)) return;
            const length = doc.offsetAt(new vscode.Position(doc.lineCount - 1, Number.MAX_SAFE_INTEGER));
            const text = limitedSnapshotText(length, () => doc.getText());
            if (text !== undefined) this.baselines.set(doc, text);
        };
        vscode.workspace.textDocuments.forEach(rememberBaseline);
        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(rememberBaseline),
            vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
                if (contentChanges.length && !document.isClosed && this._isValidDocument(document)) {
                    this.pending.change(document.uri.toString(), document);
                }
            }),
            vscode.workspace.onWillSaveTextDocument(({ document, reason }) => { this.saveReasons.set(document, reason); }),
            vscode.workspace.onDidSaveTextDocument(this._onDidSaveDocument, this),
            vscode.workspace.onDidCloseTextDocument(document => this.pending.flush(document.uri.toString())),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                const previous = active;
                active = editor?.document;
                // Opening an extension view should preserve the ordinary file list's modification order.
                const tab = vscode.window.tabGroups?.activeTabGroup.activeTab;
                if (!active && !configManager.contest && tab && tab.input instanceof vscode.TabInputWebview) return;
                if (previous && previous !== active) return this.pending.flush(previous.uri.toString());
            }),
            vscode.window.onDidChangeWindowState(state => { if (!state.focused) return this.flush(); }),
            configManager.onDidChange(() => {
                this.pending.discardWhere(document => !this._isValidDocument(document));
                vscode.workspace.textDocuments.forEach(rememberBaseline);
            }),
            { dispose: () => { void this.flush(); } },
        );
    }

    public async flushFile(filePath: string) {
        await this.pending.flush(vscode.Uri.file(filePath).toString());
        await storageManager.flush();
    }

    public async flush() {
        await this.pending.flushAll();
        await storageManager.flush();
    }

    private async _onDidSaveDocument(document: vscode.TextDocument) {
        const reason = this.saveReasons.get(document);
        this.saveReasons.delete(document);
        if (document.isClosed || !this._isValidDocument(document)) return;
        const key = document.uri.toString();
        if (reason !== undefined && reason === vscode.TextDocumentSaveReason.AfterDelay) {
            this.pending.change(key, document);
        } else {
            await this.pending.checkpoint(key, document);
        }
    }

    private _isValidDocument(document: vscode.TextDocument): boolean {
        // 1. Check if recording is enabled
        if (!configManager.isRecording()) {
            return false;
        }

        // 2. Check if file is in the tracked root folder
        const rootFolder = configManager.getRootFolder();
        const relative = rootFolder ? path.relative(rootFolder, document.uri.fsPath) : '';
        if (
            document.uri.scheme !== 'file' ||
            (rootFolder && (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)))
        ) {
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
