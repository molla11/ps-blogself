import * as vscode from 'vscode';
import { configManager } from './config';
import { storageManager } from './storage/StorageManager';
import { fileWatcher } from './storage/FileWatcher';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { BlogPostManager } from './services/BlogPostManager';
import { Logger } from './services/logger';

export async function activate(context: vscode.ExtensionContext) {
    Logger.info(`activate() is executed.`);

    // Initialize state
    await configManager.init(context);
    storageManager.init(context);
    fileWatcher.init(context);
    BlogPostManager.init(context);

    const sidebarProvider = new SidebarProvider(
        context.extensionUri,
        () => selectRootFolder(sidebarProvider),
        () => clearRootFolder(sidebarProvider),
        directory => useCurrentDirectory(sidebarProvider, directory),
        () => toggleRecording(sidebarProvider),
        (lang: string) => toggleLanguage(sidebarProvider, lang),
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider, {
            // Preserve search, loaded rows and scroll position across sidebar switches.
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );
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
    await configManager.setRootFolder(directory);
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
