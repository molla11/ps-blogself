import * as vscode from 'vscode';
import type { Checkpoint, SnapshotTrigger } from '../types';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { configManager } from '../config';
import { storageManager } from './StorageManager';
import { endsEditBatch } from './EditBatch';
import { BackgroundRecorder } from './BackgroundRecorder';
import { limitedSnapshotText } from './SnapshotLimit';
import { Logger } from '../services/logger';

export class FileWatcher {
    private static _instance: FileWatcher;
    private readonly saveReasons = new WeakMap<vscode.TextDocument, vscode.TextDocumentSaveReason>();
    private readonly undone = new WeakSet<vscode.TextDocument>();
    private readonly editSessions = new Map<string, string>();
    private readonly baselines = new WeakMap<vscode.TextDocument, string>();
    private readonly pending = new BackgroundRecorder<vscode.TextDocument>(async (document, reason) => {
        if (this.isTrackedDocument(document)) {
            try { await this.record(document, reason); }
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

    private record(document: vscode.TextDocument, reason: SnapshotTrigger) {
        const key = document.uri.toString();
        const session = this.editSessions.get(key) ?? randomUUID();
        this.editSessions.set(key, session);
        return storageManager.saveSnapshot(document, this.baselines.get(document), reason, session, this.undone.delete(document));
    }

    private finishEdits(key: string, reason: SnapshotTrigger) {
        const write = this.pending.flush(key, reason);
        if (endsEditBatch(reason)) this.editSessions.delete(key);
        return write;
    }

    public init(context: vscode.ExtensionContext) {
        let active = vscode.window.activeTextEditor?.document;
        const rememberBaseline = (doc: vscode.TextDocument) => {
            if (!this.isTrackedDocument(doc)) { this.baselines.delete(doc); return; }
            if (this.baselines.has(doc)) return;
            const length = doc.offsetAt(new vscode.Position(doc.lineCount - 1, Number.MAX_SAFE_INTEGER));
            const text = limitedSnapshotText(length, () => doc.getText());
            if (text !== undefined) this.baselines.set(doc, text);
        };
        const recordRun = (kind: Checkpoint, args: string[], cwd?: string) => {
            const doc = vscode.window.activeTextEditor?.document;
            if (!doc || doc.isDirty || !this.isTrackedDocument(doc)) return;
            if (args.some(arg => (path.isAbsolute(arg) || cwd) && path.resolve(cwd || '', arg) === doc.uri.fsPath)) {
                void this.record(doc, kind).catch(error => Logger.error('실행 기록을 저장하지 못했습니다.', error));
                this.editSessions.delete(doc.uri.toString());
            }
        };
        const commandArgs = (command: string) => (command.match(/"[^"]*"|'[^']*'|[^\s;&|]+/g) || []).map(arg => arg.replace(/^["']|["']$/g, ''));
        vscode.workspace.textDocuments.forEach(rememberBaseline);
        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(rememberBaseline),
            vscode.workspace.onDidChangeTextDocument(({ document, contentChanges, reason }) => {
                if (contentChanges.length && !document.isClosed && this.isTrackedDocument(document)) {
                    if (reason !== undefined && reason === vscode.TextDocumentChangeReason.Undo) this.undone.add(document);
                    else this.undone.delete(document);
                    this.pending.change(document.uri.toString(), document);
                }
            }),
            vscode.workspace.onWillSaveTextDocument(({ document, reason }) => { this.saveReasons.set(document, reason); }),
            vscode.workspace.onDidSaveTextDocument(this._onDidSaveDocument, this),
            vscode.workspace.onDidCloseTextDocument(document => this.finishEdits(document.uri.toString(), 'close')),
            vscode.window.onDidStartTerminalShellExecution(({ execution }) => {
                const args = commandArgs(execution.commandLine.value);
                if (args[0] && /^(?:python(?:3(?:\.\d+)?)?|node|tsx|deno|gcc|g\+\+|clang(?:\+\+)?|rustc|cargo|go|java[c]?)(?:\.exe)?$/i.test(path.basename(args[0]))) {
                    recordRun('run', args.slice(1), execution.cwd?.fsPath);
                }
            }),
            vscode.debug.onDidStartDebugSession(({ configuration, workspaceFolder }) => {
                if (typeof configuration.program === 'string') recordRun('debug', [configuration.program], workspaceFolder?.uri.fsPath);
            }),
            vscode.tasks.onDidStartTaskProcess(({ execution }) => {
                const task = execution.task, command = task.execution;
                const cwd = (task.scope && typeof task.scope === 'object') ? task.scope.uri.fsPath : undefined;
                if (command instanceof vscode.ProcessExecution) recordRun('task', [command.process, ...command.args], command.options?.cwd || cwd);
                if (command instanceof vscode.ShellExecution) {
                    const args = command.commandLine ? commandArgs(command.commandLine)
                        : (command.command ? [command.command, ...(command.args || [])] : []).map(arg => typeof arg === 'string' ? arg : arg.value);
                    recordRun('task', args, command.options?.cwd || cwd);
                }
            }),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                const previous = active;
                active = editor?.document;
                // Opening an extension view should preserve the ordinary file list's modification order.
                const tab = vscode.window.tabGroups?.activeTabGroup.activeTab;
                if (!active && !configManager.contest && tab && tab.input instanceof vscode.TabInputWebview) return;
                if (previous && previous !== active) return this.finishEdits(previous.uri.toString(), 'switch');
            }),
            vscode.window.onDidChangeWindowState(state => { if (!state.focused) return this.flush('blur').catch(error => Logger.error('수정 기록 저장 대기 중', error)); }),
            configManager.onDidChange(() => {
                this.editSessions.clear();
                this.pending.discardWhere(document => !this.isTrackedDocument(document));
                vscode.workspace.textDocuments.forEach(rememberBaseline);
            }),
            { dispose: () => { void this.flush().catch(error => Logger.error('수정 기록 저장 대기 중', error)); } },
        );
    }

    public async flushFile(filePath: string) {
        await this.finishEdits(vscode.Uri.file(filePath).toString(), 'review');
        await storageManager.flush(filePath);
    }

    public async flush(reason: SnapshotTrigger = 'close') {
        const writes = this.pending.flushAll(reason);
        if (endsEditBatch(reason)) this.editSessions.clear();
        await writes;
        await storageManager.flush();
    }

    private async _onDidSaveDocument(document: vscode.TextDocument) {
        const reason = this.saveReasons.get(document);
        this.saveReasons.delete(document);
        if (document.isClosed || !this.isTrackedDocument(document)) return;
        const key = document.uri.toString();
        if (reason !== undefined && reason === vscode.TextDocumentSaveReason.AfterDelay) {
            this.pending.change(key, document);
        } else {
            await this.pending.checkpoint(key, document, reason !== undefined && reason === vscode.TextDocumentSaveReason.FocusOut ? 'autosave' : 'save');
        }
    }

    public isTrackedDocument(document: vscode.TextDocument): boolean {
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
