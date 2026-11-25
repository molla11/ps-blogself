import { normalizeExtensions } from './settings/RecordingInput';
import * as vscode from 'vscode';
import * as path from 'path';
import { isValidFolderPath } from './util';
import { backendRequests } from './writing/BackendRequests';
import { ContestSettings, WorkspaceSettings, defaultRecordingSettings } from './storage/WorkspaceSettings';
import { atomicWrite, readJson, withFileLock } from './storage/SharedFiles';

export class ConfigManager {
    private static readonly ROOT_FOLDER_KEY = 'psb.rootFolder';
    private static readonly IS_RECORDING_KEY = 'psb.isRecording';
    private static readonly LANGUAGES_KEY = 'psb.languages';
    private static _instance: ConfigManager;
    private _lastFile?: vscode.Uri;
    private windowRoot?: string;
    private settings = new WorkspaceSettings();
    private changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;

    private constructor() {}

    public static getInstance(): ConfigManager {
        if (!ConfigManager._instance) {
            ConfigManager._instance = new ConfigManager();
        }
        return ConfigManager._instance;
    }

    public async init(context: vscode.ExtensionContext) {
        this.windowRoot = undefined;
        this.settings = context.storageUri
            ? new WorkspaceSettings(path.join(context.storageUri.fsPath, 'recording-settings.json'))
            : new WorkspaceSettings(path.join(context.globalStorageUri.fsPath, 'empty-window-contest.json'), 'contestOnly');
        const migration = path.join(context.globalStorageUri.fsPath, 'recording-settings-migration.json');
        await withFileLock(migration, async () => {
            const initial = defaultRecordingSettings();
            if (context.storageUri && !await readJson(migration)) {
                initial.root = context.globalState.get<string>(ConfigManager.ROOT_FOLDER_KEY, '');
                initial.recording = context.globalState.get<boolean>(ConfigManager.IS_RECORDING_KEY, true);
                initial.languages = context.globalState.get<string[]>(ConfigManager.LANGUAGES_KEY, ['c', 'cpp', 'py']);
                await this.settings.init(initial);
                await atomicWrite(migration, { workspace: context.storageUri.toString() });
            } else await this.settings.init();
        });
        const syncBackend = () => backendRequests.setEnabled(this.contest?.backend ?? true);
        syncBackend();
        context.subscriptions.push(this.onDidChange(syncBackend), this.settings.watch(() => this.changed.fire()));
        this._lastFile = vscode.window.activeTextEditor?.document.uri;
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor?.document.uri.scheme === 'file') this._lastFile = editor.document.uri;
        }));
    }

    public getCurrentDirectory(): string {
        const folder = (this._lastFile && vscode.workspace.getWorkspaceFolder(this._lastFile))
            || vscode.workspace.workspaceFolders?.[0];
        if (folder?.uri.scheme === 'file') return folder.uri.fsPath;
        return this._lastFile?.scheme === 'file' ? path.dirname(this._lastFile.fsPath) : '';
    }

    public getRootFolder(): string {
        return this.windowRoot ?? this.settings.value.root.trim();
    }

    public isWindowRoot(): boolean {
        return this.windowRoot !== undefined;
    }

    public async setRootFolder(folderPath: string, windowOnly = false): Promise<void> {
        const input = folderPath.trim();
        const root = input ? path.resolve(this.getCurrentDirectory() || '.', input) : '';
        if (root && !isValidFolderPath(root)) throw new Error('존재하는 폴더를 선택해 주세요.');
        // Selecting this window's current directory must never change another
        // window's recorder. Later edits and resets retain that local scope.
        if (windowOnly || this.isWindowRoot()) this.windowRoot = root;
        else await this.settings.update(value => { value.root = root; });
        this.changed.fire();
    }

    public get contest() { return this.settings.value.contest; }

    public async setContestMode(enabled: boolean) {
        await this.settings.update(settings => {
            if (enabled) {
                settings.contest ??= settings.lastContest ?? { recording: true, backend: false, writing: false };
                delete settings.lastContest;
            } else if (settings.contest) {
                settings.lastContest = settings.contest;
                delete settings.contest;
            }
        });
        this.changed.fire();
    }

    public async setContestOption(option: keyof ContestSettings, enabled: boolean) {
        await this.settings.update(settings => {
            if (settings.contest) settings.contest[option] = enabled;
        });
        this.changed.fire();
    }

    public isRecording(): boolean {
        return this.contest?.recording ?? this.settings.value.recording;
    }

    public async setRecording(value: boolean): Promise<void> {
        await this.settings.update(settings => { (settings.contest ?? settings).recording = value; });
        this.changed.fire();
    }

    public async toggleRecording(): Promise<void> {
        await this.settings.update(settings => {
            const active = settings.contest ?? settings;
            active.recording = !active.recording;
        });
        this.changed.fire();
    }

    public getSupportedLanguages(): string[] {
        return [...this.settings.value.languages];
    }

    public async setSupportedLanguages(languages: string[]): Promise<void> {
        const extensions = normalizeExtensions(languages);
        await this.settings.update(value => { value.languages = extensions; });
        this.changed.fire();
    }

    public async toggleLanguage(lang: string): Promise<void> {
        lang = normalizeExtensions([lang])[0];
        await this.settings.update(value => {
            const index = value.languages.indexOf(lang);
            if (index > -1) value.languages.splice(index, 1); else value.languages.push(lang);
        });
        this.changed.fire();
    }
}

// For backward compatibility or simpler access if preferred,
// though using instance directly is cleaner.
export const configManager = ConfigManager.getInstance();
