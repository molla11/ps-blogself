import * as vscode from 'vscode';
import { consts } from './consts';
import type { folderPath } from './types';

const configTarget = vscode.ConfigurationTarget.Global; // or .Workspace

export function getRootFolder() {
    return vscode.workspace
        .getConfiguration()
        .get<folderPath>(`${consts.EXT_PREFIX}.${consts.configs.ROOT_FOLDER}`);
}

export async function setRootFolder(folderPath: folderPath) {
    vscode.workspace
        .getConfiguration()
        .update(`${consts.EXT_PREFIX}.${consts.configs.ROOT_FOLDER}`, folderPath, configTarget);
}
