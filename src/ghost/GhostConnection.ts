import * as vscode from 'vscode';
import { GhostClient, GhostSettings, ghostToken, ghostUrl } from './GhostClient';

/** The webview only receives a public URL and connection status, never the Admin key. */
export class GhostConnection {
    static readonly key = 'psb.ghost.connection';
    private configuring?: Promise<GhostSettings | undefined>;
    constructor(private readonly context: vscode.ExtensionContext) {}
    async get(): Promise<GhostSettings | undefined> {
        const value = await this.context.secrets.get(GhostConnection.key);
        return value ? JSON.parse(value) : undefined;
    }
    configure(): Promise<GhostSettings | undefined> {
        return this.configuring ||= this.prompt().finally(() => { this.configuring = undefined; });
    }
    private async prompt(): Promise<GhostSettings | undefined> {
        const current = await this.get();
        if (current) {
            const choice = await vscode.window.showQuickPick(['연결 변경', '연결 해제'], { title: `Ghost · ${new URL(current.url).host}` });
            if (!choice) return current;
            if (choice === '연결 해제') { await this.context.secrets.delete(GhostConnection.key); return undefined; }
        }
        const url = await vscode.window.showInputBox({ title: 'Ghost 연결', prompt: '블로그 공개 주소를 입력해 주세요.', placeHolder: 'https://blog.example.com', value: current?.url, ignoreFocusOut: true,
            validateInput: value => { try { ghostUrl(value); return undefined; } catch { return 'HTTPS 블로그 주소를 입력해 주세요. 로컬 테스트는 HTTP를 사용할 수 있습니다.'; } } });
        if (!url) return current;
        const key = await vscode.window.showInputBox({ title: 'Ghost Admin API 키', prompt: 'Ghost 설정 → Advanced → Integrations → Add custom integration에서 Admin API 키를 복사해 주세요.', password: true, ignoreFocusOut: true,
            validateInput: value => { try { ghostToken(value.trim()); return undefined; } catch { return 'Admin API 키 형식을 확인해 주세요. Content API 키는 사용할 수 없습니다.'; } } });
        if (!key) return current;
        const settings = { url: ghostUrl(url), key: key.trim() };
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Ghost 연결 확인' }, () => new GhostClient(settings).check());
        await this.context.secrets.store(GhostConnection.key, JSON.stringify(settings));
        return settings;
    }
}
