import { atomicWrite, observeFile, readJson, withFileLock } from './SharedFiles';

export interface ContestSettings { recording: boolean; backend: boolean; writing: boolean }
export interface RecordingSettings { root: string; recording: boolean; languages: string[]; contest?: ContestSettings; lastContest?: ContestSettings }
export const defaultRecordingSettings = (): RecordingSettings => ({ root: '', recording: true, languages: ['c', 'cpp', 'py'] });
export class WorkspaceSettings {
    value = defaultRecordingSettings();
    constructor(private file?: string, private scope: 'workspace' | 'contestOnly' = 'workspace') {}
    private async read() {
        const saved = await readJson<RecordingSettings>(this.file!);
        if (!saved || this.scope === 'workspace') return saved;
        return { ...this.value, contest: saved.contest, lastContest: saved.lastContest };
    }
    private write(value: RecordingSettings) {
        const { contest, lastContest } = value;
        return atomicWrite(this.file!, this.scope === 'workspace' ? value : { contest, lastContest });
    }
    async init(initial = defaultRecordingSettings()) {
        if (!this.file) { this.value = structuredClone(initial); return; }
        await withFileLock(this.file, async () => {
            const saved = await this.read();
            this.value = saved || structuredClone(initial);
            if (!saved) await this.write(this.value);
        });
    }
    async update(edit: (value: RecordingSettings) => void) {
        const update = async () => {
            const value = (this.file && await this.read()) || structuredClone(this.value);
            edit(value);
            if (this.file) await this.write(value);
            this.value = value;
        };
        if (this.file) await withFileLock(this.file, update); else await update();
    }
    watch(changed: () => void) {
        if (!this.file) return { dispose() {} };
        return observeFile(this.file, () => {
            void withFileLock(this.file!, async () => {
                const value = await this.read();
                if (value) { this.value = value; changed(); }
            }).catch(() => {});
        });
    }
}
