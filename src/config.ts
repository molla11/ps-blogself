import * as vscode from 'vscode';
import { consts } from './consts';

const configTarget = vscode.ConfigurationTarget.Global; // or .Workspace

export function getRootFolder() {
    const raw = vscode.workspace
        .getConfiguration()
        .get<string>(`${consts.EXT_PREFIX}.${consts.configs.ROOT_FOLDER}`, '');

    return raw;
}

export async function setRootFolder(folderPath: string) {
    vscode.workspace
        .getConfiguration()
        .update(`${consts.EXT_PREFIX}.${consts.configs.ROOT_FOLDER}`, folderPath, configTarget);
}
