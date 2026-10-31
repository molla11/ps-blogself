import * as path from 'node:path';
import { atomicWrite, readJson, withFileLock } from '../storage/SharedFiles';

/** Shared across windows in this VS Code profile, independent of workspace or version. */
export class WelcomeState {
    private readonly file: string;
    constructor(storageDirectory: string) {
        this.file = path.join(storageDirectory, 'welcome.json');
    }
    showOnce(show: () => void): Promise<boolean> {
        return withFileLock(this.file, async () => {
            if ((await readJson<{ shown?: boolean }>(this.file))?.shown) return false;
            show();
            await atomicWrite(this.file, { shown: true });
            return true;
        });
    }
}
