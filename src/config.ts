import * as vscode from 'vscode';
import { isValidFolderPath } from './util';

export class ConfigManager {
    private static readonly ROOT_FOLDER_KEY = 'psb.rootFolder';
    private static readonly IS_RECORDING_KEY = 'psb.isRecording';
    private static readonly LANGUAGES_KEY = 'psb.languages';
    private static _instance: ConfigManager;
    private _context?: vscode.ExtensionContext;

    private constructor() {}

    public static getInstance(): ConfigManager {
        if (!ConfigManager._instance) {
            ConfigManager._instance = new ConfigManager();
        }
        return ConfigManager._instance;
    }

    public init(context: vscode.ExtensionContext) {
        this._context = context;
    }

    public getRootFolder(): string {
        const folderPath =
            this._context?.globalState.get<string>(ConfigManager.ROOT_FOLDER_KEY, '') || '';

        if (folderPath && !isValidFolderPath(folderPath)) {
            return '';
        }

        return folderPath.trim();
    }

    public async setRootFolder(folderPath: string): Promise<void> {
        await this._context?.globalState.update(ConfigManager.ROOT_FOLDER_KEY, folderPath);
    }

    public isRecording(): boolean {
        return (
            this._context?.globalState.get<boolean>(ConfigManager.IS_RECORDING_KEY, true) ?? true
        );
    }

    public async setRecording(value: boolean): Promise<void> {
        await this._context?.globalState.update(ConfigManager.IS_RECORDING_KEY, value);
    }

    public getSupportedLanguages(): string[] {
        return (
            this._context?.globalState.get<string[]>(ConfigManager.LANGUAGES_KEY, [
                'c',
                'cpp',
                'py',
            ]) ?? ['c', 'cpp', 'py']
        );
    }

    public async toggleLanguage(lang: string): Promise<void> {
        const langs = this.getSupportedLanguages();
        const index = langs.indexOf(lang);
        if (index > -1) {
            langs.splice(index, 1);
        } else {
            langs.push(lang);
        }
        await this._context?.globalState.update(ConfigManager.LANGUAGES_KEY, langs);
    }
}

// For backward compatibility or simpler access if preferred,
// though using instance directly is cleaner.
export const configManager = ConfigManager.getInstance();
