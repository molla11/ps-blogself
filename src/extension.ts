import * as vscode from 'vscode';
import { configManager } from './config';
import { storageManager } from './storage/StorageManager';
import { fileWatcher } from './storage/FileWatcher';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { Logger } from './services/logger';

export async function activate(context: vscode.ExtensionContext) {
    Logger.info(`activate() is executed.`);

    // Initialize state
    configManager.init(context);
    storageManager.init(context);
    fileWatcher.init(context);

    const sidebarProvider = new SidebarProvider(
        context.extensionUri,
        () => selectRootFolder(sidebarProvider),
        () => clearRootFolder(sidebarProvider),
        () => useWorkspaceRoot(sidebarProvider),
        () => toggleRecording(sidebarProvider),
        (lang: string) => toggleLanguage(sidebarProvider, lang),
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider),
    );
}

async function selectRootFolder(sidebarProvider: SidebarProvider) {
    const result = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '선택 완료',
        defaultUri:
            vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.env.HOME ?? '/'),
    });

    if (!result || result.length === 0) {
        const rootPath = configManager.getRootFolder();
        vscode.window.showInformationMessage(
            `현재 트래킹 경로: ${rootPath.length === 0 ? '전체 워크스페이스' : rootPath}`,
        );
        return;
    }

    const path = result[0].fsPath;
    await configManager.setRootFolder(path);
    sidebarProvider.updateState();

    vscode.window.showInformationMessage(`이제 ${path} 아래의 변경 사항을 기록합니다.`);
}

async function clearRootFolder(sidebarProvider: SidebarProvider) {
    await configManager.setRootFolder('');
    sidebarProvider.updateState();

    vscode.window.showInformationMessage('이제 전체 워크스페이스의 변경 사항을 기록합니다.');
}

async function useWorkspaceRoot(sidebarProvider: SidebarProvider) {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
        vscode.window.showErrorMessage('열려 있는 워크스페이스 폴더가 없습니다.');
        return;
    }

    const path = wsFolder.uri.fsPath;
    await configManager.setRootFolder(path);
    sidebarProvider.updateState();

    vscode.window.showInformationMessage(
        `이제 워크스페이스 루트(${path}) 아래의 변경 사항을 기록합니다.`,
    );
}

async function toggleRecording(sidebarProvider: SidebarProvider) {
    const newState = !configManager.isRecording();
    await configManager.setRecording(newState);
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

export function deactivate() {}
