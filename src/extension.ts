import * as vscode from 'vscode';
import { consts } from './consts';
import { getRootFolder, setRootFolder } from './config';

export async function activate(context: vscode.ExtensionContext) {
    console.log(`${consts.EXTENSION_ID}: activate() is executed.`);

    const commands = [
        vscode.commands.registerCommand(`${consts.EXT_PREFIX}.selectRootFolder`, selectRootFolder),
        vscode.commands.registerCommand(`${consts.EXT_PREFIX}.clearRootFolder`, clearRootFolder),
    ];

    commands.forEach((cmd) => {
        context.subscriptions.push(cmd);
    });
}

async function selectRootFolder() {
    const result = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '선택 완료',
        defaultUri:
            vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.env.HOME ?? '/'),
    });

    if (!result || result.length === 0) {
        const rootPath = getRootFolder();
        vscode.window.showInformationMessage(
            `현재 루트 폴더(변경되지 않음): ${rootPath.length === 0 ? '전체 워크스페이스' : rootPath}`,
        );

        return;
    }

    const path = result[0].fsPath;
    await setRootFolder(path);

    vscode.window.showInformationMessage(`이제 ${path} 아래의 변경 사항을 기록합니다.`);
}

async function clearRootFolder() {
    await setRootFolder('');

    vscode.window.showInformationMessage('이제 전체 워크스페이스의 변경 사항을 기록합니다.');
}

export function deactivate() {}
