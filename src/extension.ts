import * as vscode from 'vscode';
import { consts } from './consts';
import { getRootFolder, setRootFolder } from './config';

export async function activate(context: vscode.ExtensionContext) {
    console.log(`${consts.EXTENSION_ID}: activate() is executed.`);

    const commands = [
        vscode.commands.registerCommand(`${consts.EXT_PREFIX}.selectRootFolder`, async () => {
            await selectRootFolder();
        }),
        vscode.commands.registerCommand(`${consts.EXT_PREFIX}.clearRootFolder`, async () => {
            await clearRootFolder();
        }),
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
        openLabel: '변경 사항을 기록할 루트 폴더',
        defaultUri:
            vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.env.HOME ?? '/'),
    });

    if (!result || result.length === 0) {
        const currentRootFolder = getRootFolder();
        vscode.window.showInformationMessage(
            `현재 루트 폴더(변경되지 않음): ${currentRootFolder ?? '전체 워크스페이스'}`,
        );

        return;
    }

    const folderPath = result[0].fsPath;
    await setRootFolder(folderPath);

    vscode.window.showInformationMessage(
        `변경 사항을 기록할 루트 폴더가 저장되었습니다: ${folderPath}`,
    );
}

async function clearRootFolder() {
    await setRootFolder(undefined);

    vscode.window.showInformationMessage('이제 전체 워크스페이스의 변경 사항을 기록합니다.');
}

export function deactivate() {}
