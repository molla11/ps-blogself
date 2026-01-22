import * as vscode from 'vscode';

import { consts } from './consts';
import { isValidFolderPath } from './util';

const configTarget = vscode.ConfigurationTarget.Global; // or .Workspace

let hasWarnedInvalidRoot = false;

export function getRootFolder() {
    const raw = vscode.workspace
        .getConfiguration()
        .get<string>(`${consts.EXT_PREFIX}.${consts.configs.ROOT_FOLDER}`, '');
    const folderPath = raw.trim();

    if (!isValidFolderPath(folderPath)) {
        if (!hasWarnedInvalidRoot) {
            vscode.window.showErrorMessage(
                `루트 폴더 경로가 잘못되었습니다. 설정 > ${consts.EXT_PREFIX}.${consts.configs.ROOT_FOLDER}에서 올바른 경로를 지정해 주세요.`,
            );
            hasWarnedInvalidRoot = true;
        }
        return '';
    }

    return folderPath;
}

export async function setRootFolder(folderPath: string) {
    vscode.workspace
        .getConfiguration()
        .update(`${consts.EXT_PREFIX}.${consts.configs.ROOT_FOLDER}`, folderPath, configTarget);
}
