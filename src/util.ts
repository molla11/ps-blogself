import * as fs from 'fs';
import * as path from 'path';

export function isValidFolderPath(folderPath: string): boolean {
    try {
        if (!folderPath) return false;

        const resolved = path.resolve(folderPath);
        return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
    } catch {
        return false;
    }
}
