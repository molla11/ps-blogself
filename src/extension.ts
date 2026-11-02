import { WelcomePanel } from './welcome/WelcomePanel';
import { WelcomeState } from './welcome/WelcomeState';
import { SettingsPanel } from './settings/SettingsPanel';
import * as vscode from 'vscode';
import { configManager } from './config';
import { storageManager } from './storage/StorageManager';
import { fileWatcher } from './storage/FileWatcher';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { BlogPostManager } from './services/BlogPostManager';
import { Logger } from './services/logger';
import { loadConnectionEnvironment, resolveConnectionSettings, requireBackend } from './writing/ConnectionSettings';

export async function activate(context: vscode.ExtensionContext) {
    Logger.info(`activate() is executed.`);

    const developmentMode = context.extensionMode !== vscode.ExtensionMode.Production;
    const development = await loadConnectionEnvironment(context.extensionPath, developmentMode);
    if (developmentMode) await requireBackend(resolveConnectionSettings(process.env, development).apiUrl);

    // Initialize state
    await configManager.init(context);
    storageManager.init(context);
    fileWatcher.init(context);
    BlogPostManager.init(context, development);

    const sidebarProvider = new SidebarProvider(
        context.extensionUri,
        () => selectRootFolder(sidebarProvider),
        () => clearRootFolder(sidebarProvider),
        directory => useCurrentDirectory(sidebarProvider, directory),
        () => toggleRecording(sidebarProvider),
        (lang: string) => toggleLanguage(sidebarProvider, lang),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('psb.openSettings', () => SettingsPanel.show()),
        vscode.commands.registerCommand('psb.welcome', () => WelcomePanel.show()),
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider, {
            // Preserve search, loaded rows and scroll position across sidebar switches.
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    try { await new WelcomeState(context.globalStorageUri.fsPath).showOnce(() => WelcomePanel.show()); }
    catch (error) { Logger.warn('시작 안내 표시 상태를 저장하지 못했습니다.', error); }
}

async function selectRootFolder(sidebarProvider: SidebarProvider) {
    const directory = configManager.getCurrentDirectory();
    const result = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '선택 완료',
        defaultUri: directory ? vscode.Uri.file(directory) : undefined,
    });

    if (!result?.length) return;

    const path = result[0].fsPath;
    await configManager.setRootFolder(path);
    await sidebarProvider.updateState();
}

async function clearRootFolder(sidebarProvider: SidebarProvider) {
    await configManager.setRootFolder('');
    await sidebarProvider.updateState();
}

async function useCurrentDirectory(sidebarProvider: SidebarProvider, directory: string) {
    await configManager.setRootFolder(directory, true);
    await sidebarProvider.updateState();
}

async function toggleRecording(sidebarProvider: SidebarProvider) {
    await configManager.toggleRecording();
    const newState = configManager.isRecording();
    sidebarProvider.updateState();

    if (newState) {
        vscode.window.showInformationMessage('변경 사항 기록을 시작합니다.');
    } else {
        vscode.window.showInformationMessage('변경 사항 기록을 중지했습니다.');
    }
}

async function toggleLanguage(sidebarProvider: SidebarProvider, lang: string) {
    await configManager.toggleLanguage(lang);
    sidebarProvider.updateState();
}

export async function deactivate() {
    await storageManager.flush();
    await BlogPostManager.flush();
}
