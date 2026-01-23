import * as fs from 'fs';
import * as path from 'path';

export function isValidFolderPath(folderPath: string): boolean {
    if (folderPath.trim() === '') return true;

    try {
        const resolved = path.resolve(folderPath);
        return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
    } catch {
        return false;
    }
}
