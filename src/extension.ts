import { backendRequests } from './writing/BackendRequests';
import { WelcomePanel } from './welcome/WelcomePanel';
import { WelcomeState } from './welcome/WelcomeState';
import { SettingsPanel } from './settings/SettingsPanel';
import * as vscode from 'vscode';
import { configManager } from './config';
import { storageManager } from './storage/StorageManager';
import { fileWatcher } from './storage/FileWatcher';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { extname } from 'node:path';
import { CodeDiscovery, codeFileExtensions } from './sidebar/CodeDiscovery';
import { BlogPostManager } from './services/BlogPostManager';
import { Logger } from './services/logger';
import { loadConnectionEnvironment, resolveConnectionSettings, requireBackend } from './writing/ConnectionSettings';

export async function activate(context: vscode.ExtensionContext) {
    Logger.info(`activate() is executed.`);

    const developmentMode = context.extensionMode !== vscode.ExtensionMode.Production;
    const development = await loadConnectionEnvironment(context.extensionPath, developmentMode);
    await configManager.init(context);
    if (developmentMode && backendRequests.enabled) {
        await requireBackend(resolveConnectionSettings(process.env, development).apiUrl, backendRequests.fetch);
    }
    storageManager.init(context);
    await BlogPostManager.init(context, development);
    fileWatcher.init(context);

    const codeFiles = new CodeDiscovery(() => configManager.getCurrentDirectory());
    context.subscriptions.push(codeFiles);
    const showWelcome = () => WelcomePanel.show(codeFiles, context.extensionUri);
    const sidebarProvider = new SidebarProvider(
        context.extensionUri,
        () => selectRootFolder(sidebarProvider),
        () => clearRootFolder(sidebarProvider),
        directory => useCurrentDirectory(sidebarProvider, directory),
        () => toggleRecording(sidebarProvider),
        (lang: string) => toggleLanguage(sidebarProvider, lang),
        codeFiles,
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('psb.openSettings', () => SettingsPanel.show()),
        vscode.commands.registerCommand('psb.welcome', showWelcome),
        vscode.commands.registerCommand('psb.createCodeFile', createCodeFile),
        vscode.commands.registerCommand('psb.openFolderFromWelcome', () => openFolderFromWelcome(context)),
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider, {
            // Preserve search, loaded rows and scroll position across sidebar switches.
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    try {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        const key = root && sidebarOnOpenKey(root);
        const requestedAt = key && context.globalState.get<number>(key);
        if (key && requestedAt) await context.globalState.update(key, undefined);
        if (requestedAt && Date.now() - requestedAt < 5 * 60_000) {
            void vscode.commands.executeCommand('psb.sidebar.focus').then(undefined, showWelcome);
        } else {
            await new WelcomeState(context.globalStorageUri.fsPath).showOnce(showWelcome);
        }
    }
    catch (error) { Logger.warn('시작 안내 표시 상태를 저장하지 못했습니다.', error); }
}

function sidebarOnOpenKey(folder: vscode.Uri) {
    const uri = folder.toString();
    return 'psb.sidebarOnOpen:' + (process.platform === 'win32' ? uri.toLowerCase() : uri);
}

async function openFolderFromWelcome(context: vscode.ExtensionContext) {
    const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '폴더 열기',
    });
    const folder = folders?.[0];
    if (!folder) return;
    const key = sidebarOnOpenKey(folder);
    const roots = vscode.workspace.workspaceFolders;
    if (!vscode.workspace.workspaceFile && roots?.length === 1 && sidebarOnOpenKey(roots[0].uri) === key) {
        await vscode.commands.executeCommand('psb.sidebar.focus');
        return;
    }
    // Opening a different folder replaces this extension host. The destination
    // consumes the request once, without stealing focus on ordinary reloads.
    await context.globalState.update(key, Date.now());
    try { await vscode.commands.executeCommand('vscode.openFolder', folder, { forceReuseWindow: true }); }
    catch (error) {
        await context.globalState.update(key, undefined);
        throw error;
    }
}

async function createCodeFile() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return vscode.commands.executeCommand('psb.openFolderFromWelcome');
    const directory = configManager.getCurrentDirectory();
    const base = directory ? vscode.Uri.file(directory) : folder.uri;
    const enabled = configManager.getSupportedLanguages();
    const extension = ['cpp', 'py', 'c'].find(ext => enabled.includes(ext)) || 'cpp';
    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(base, 'solve.' + extension),
        filters: { '코드 파일': codeFileExtensions }, saveLabel: '코드 파일 만들기',
    });
    if (!uri) return;
    if (!codeFileExtensions.includes(extname(uri.path).slice(1).toLowerCase())) {
        throw new Error('.c, .cpp, .py 중 하나로 파일 이름을 끝내 주세요.');
    }
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { ignoreIfExists: true });
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('코드 파일을 만들지 못했습니다. 폴더의 쓰기 권한을 확인해 주세요.');
    await vscode.window.showTextDocument(uri, { preview: false });
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
    await fileWatcher.flush();
    await BlogPostManager.flush();
}
