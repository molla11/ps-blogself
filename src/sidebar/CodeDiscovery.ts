import * as path from 'node:path';
import * as vscode from 'vscode';
import { Logger } from '../services/logger';
import type { SessionIndexItem } from '../types';
import { FileModifiedTimes, filePathKey as pathKey } from '../storage/FileModifiedTime';

const pattern = '**/*.{[cC],[cC][pP][pP],[pP][yY]}';
const ignoredFolders = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
const exclude = `**/{${[...ignoredFolders].join(',')}}/**`;
const languages = new Map([['.c', 'c'], ['.cpp', 'cpp'], ['.py', 'python']]);
export const codeFileExtensions = [...languages.keys()].map(extension => extension.slice(1));

type DiscoveredFile = Pick<SessionIndexItem, 'filePath' | 'fileName' | 'language'> & { source: 'open' | 'folder' };
export type ListedFile = SessionIndexItem | DiscoveredFile;

function collectFiles(uris: Iterable<vscode.Uri>, source: DiscoveredFile['source']) {
    const files = new Map<string, DiscoveredFile>();
    for (const uri of uris) {
        if (uri.scheme !== 'file') continue;
        const filePath = uri.fsPath;
        const language = languages.get(path.extname(filePath).toLowerCase());
        if (language) files.set(pathKey(filePath), { filePath, fileName: path.basename(filePath), language, source });
    }
    return files;
}

/** A window-local list of file names. Discovery never opens documents or writes snapshots. */
export class CodeDiscovery implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    private readonly modifiedTimes = new FileModifiedTimes();
    private readonly listeners: vscode.Disposable[] = [];
    private watcher?: vscode.FileSystemWatcher;
    private readonly externalWatchers = new Map<string, vscode.FileSystemWatcher>();
    private pending?: vscode.CancellationTokenSource;
    private timer?: NodeJS.Timeout;
    private dateTimer?: NodeJS.Timeout;
    private directory?: string;
    private openFiles = new Map<string, DiscoveredFile>();
    private folderFiles: DiscoveredFile[] = [];
    files: readonly DiscoveredFile[] = [];
    get searching() { return !!this.pending; }
    failed = false;

    constructor(private readonly currentDirectory: () => string) {}

    start() {
        if (this.listeners.length) return;
        const sync = () => this.sync();
        this.listeners.push(vscode.window.tabGroups.onDidChangeTabs(sync),
            vscode.window.onDidChangeActiveTextEditor(sync), vscode.workspace.onDidChangeWorkspaceFolders(sync),
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (doc.uri.scheme === 'file' && this.openFiles.has(pathKey(doc.uri.fsPath))) this.refreshDates(doc.uri.fsPath);
            }));
        this.sync();
    }

    private sync() {
        const uris: vscode.Uri[] = [];
        for (const group of vscode.window.tabGroups.all) {
            for (const { input } of group.tabs) {
                if (input instanceof vscode.TabInputText) uris.push(input.uri);
                else if (input instanceof vscode.TabInputTextDiff) uris.push(input.original, input.modified);
            }
        }
        const open = collectFiles(uris, 'open');
        const tabsChanged = open.size !== this.openFiles.size ||
            [...open].some(([key, file]) => this.openFiles.get(key)?.filePath !== file.filePath);
        this.openFiles = open;
        const directory = this.currentDirectory();
        if (tabsChanged || directory !== this.directory) this.watchExternalTabs(directory);
        if (directory === this.directory) {
            if (tabsChanged) this.publish();
            return;
        }

        this.stopSearch();
        this.watcher?.dispose();
        this.watcher = undefined;
        this.directory = directory;
        this.folderFiles = [];
        this.failed = false;
        if (!directory) { this.publish(); return; }
        const scope = new vscode.RelativePattern(vscode.Uri.file(directory), pattern);
        // A directory created or moved with its contents may produce only a directory event.
        const watchScope = new vscode.RelativePattern(scope.baseUri, '**/*');
        const watcher = this.watcher = vscode.workspace.createFileSystemWatcher(watchScope);
        const ignored = (uri: vscode.Uri) => path.relative(directory, uri.fsPath).split(path.sep).some(part => ignoredFolders.has(part));
        const rescan = () => {
            if (this.watcher !== watcher) return;
            clearTimeout(this.timer);
            this.timer = setTimeout(() => { void this.search(scope); }, 200);
        };
        watcher.onDidChange(uri => {
            if (languages.has(path.extname(uri.fsPath).toLowerCase()) && !ignored(uri)) this.refreshDates(uri.fsPath);
        });
        watcher.onDidCreate(async uri => {
            if (ignored(uri)) return;
            this.modifiedTimes.invalidate(uri.fsPath);
            if (!languages.has(path.extname(uri.fsPath).toLowerCase())) {
                try {
                    const stat = await vscode.workspace.fs.stat(uri);
                    if (!(stat.type & vscode.FileType.Directory)) return;
                } catch { return; } // Already removed.
            }
            rescan();
        });
        watcher.onDidDelete(uri => {
            if (ignored(uri)) return;
            this.modifiedTimes.invalidate(uri.fsPath);
            const prefix = pathKey(uri.fsPath + path.sep);
            if (this.searching || languages.has(path.extname(uri.fsPath).toLowerCase())
                || this.folderFiles.some(file => pathKey(file.filePath).startsWith(prefix))) {
                rescan();
            }
        });
        void this.search(scope);
    }

    private watchExternalTabs(directory: string) {
        const parents = new Set<string>();
        for (const { filePath } of this.openFiles.values()) {
            const relative = path.relative(directory, filePath);
            if (!directory || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) parents.add(path.dirname(filePath));
        }
        for (const [parent, watcher] of this.externalWatchers) {
            if (!parents.has(parent)) { watcher.dispose(); this.externalWatchers.delete(parent); }
        }
        for (const parent of parents) {
            if (this.externalWatchers.has(parent)) continue;
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(parent), '*'));
            const update = (uri: vscode.Uri) => {
                if (this.openFiles.has(pathKey(uri.fsPath))) this.refreshDates(uri.fsPath);
            };
            watcher.onDidChange(update);
            watcher.onDidCreate(update);
            watcher.onDidDelete(update);
            this.externalWatchers.set(parent, watcher);
        }
    }

    private async search(scope: vscode.RelativePattern) {
        this.stopSearch();
        const request = this.pending = new vscode.CancellationTokenSource();
        this.failed = false;
        this.publish();
        try {
            const uris = await vscode.workspace.findFiles(scope, exclude, undefined, request.token);
            if (request !== this.pending) return;
            this.folderFiles = [...collectFiles(uris, 'folder').values()];
        } catch (error) {
            if (request !== this.pending) return;
            this.failed = true;
            Logger.warn('현재 폴더의 코드 파일을 찾지 못했습니다.', error);
        } finally {
            if (request === this.pending) {
                this.pending = undefined;
                request.dispose();
                this.publish();
            }
        }
    }

    private publish() {
        this.files = [...this.openFiles.values(), ...this.folderFiles.filter(file => !this.openFiles.has(pathKey(file.filePath)))];
        this.modifiedTimes.retain(this.files);
        this.changed.fire();
    }

    private refreshDates(filePath: string) {
        this.modifiedTimes.invalidate(filePath);
        if (this.dateTimer) return;
        this.dateTimer = setTimeout(() => {
            this.dateTimer = undefined;
            this.changed.fire();
        }, 150);
    }

    currentFiles(history: SessionIndexItem[]) {
        return this.modifiedTimes.newestFirst(this.files, history);
    }

    withHistory(history: SessionIndexItem[]) {
        const recorded = new Set(history.map(file => pathKey(file.filePath)));
        return this.modifiedTimes.newestFirst<ListedFile>([...history, ...this.files.filter(file => !recorded.has(pathKey(file.filePath)))]);
    }

    private stopSearch() {
        clearTimeout(this.timer);
        this.pending?.cancel();
        this.pending?.dispose();
        this.pending = undefined;
    }

    dispose() {
        clearTimeout(this.dateTimer);
        this.externalWatchers.forEach(watcher => watcher.dispose());
        this.stopSearch();
        this.watcher?.dispose();
        this.watcher = undefined;
        this.listeners.forEach(listener => listener.dispose());
        this.changed.dispose();
    }
}
