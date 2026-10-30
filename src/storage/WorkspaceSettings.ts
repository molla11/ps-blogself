import { atomicWrite, observeFile, readJson, withFileLock } from './SharedFiles';

export interface RecordingSettings { root: string; recording: boolean; languages: string[] }
export const defaultRecordingSettings = (): RecordingSettings => ({ root: '', recording: true, languages: ['c', 'cpp', 'py'] });
export class WorkspaceSettings {
    value = defaultRecordingSettings();
    constructor(private file?: string) {}
    async init(initial = defaultRecordingSettings()) {
        if (!this.file) { this.value = structuredClone(initial); return; }
        await withFileLock(this.file, async () => {
            const saved = await readJson<RecordingSettings>(this.file!);
            this.value = saved || structuredClone(initial);
            if (!saved) await atomicWrite(this.file!, this.value);
        });
    }
    async update(edit: (value: RecordingSettings) => void) {
        const update = async () => {
            const value = (this.file && await readJson<RecordingSettings>(this.file)) || structuredClone(this.value);
            edit(value);
            if (this.file) await atomicWrite(this.file, value);
            this.value = value;
        };
        if (this.file) await withFileLock(this.file, update); else await update();
    }
    watch(changed: () => void) {
        if (!this.file) return { dispose() {} };
        return observeFile(this.file, () => {
            void withFileLock(this.file!, async () => {
                const value = await readJson<RecordingSettings>(this.file!);
                if (value) { this.value = value; changed(); }
            }).catch(() => {});
        });
    }
}
