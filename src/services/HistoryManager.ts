import * as vscode from 'vscode';
import * as path from 'path';
import { HistoryStream } from './HistoryStream';
import { fileWatcher } from '../storage/FileWatcher';
import historyTemplate from './templates/history.html';
import historyCss from './templates/history.css';
import historyScript from './templates/historyScripts.webview.js';
import { storageManager, HistoryConflict } from '../storage/StorageManager';
import { readSavedFileHistory } from '../storage/SavedFileHistory';
import { historyFingerprint } from '../writing/model';
import { FileHistory } from '../types';
import { BlogPostManager } from './BlogPostManager';
import { randomBytes } from 'crypto';

const htmlText = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export class HistoryManager {
    public static readonly viewType = 'psb.history';

    public static async openHistory(extensionUri: vscode.Uri, filePath: string, discoveredLanguage?: string) {
        const panel = vscode.window.createWebviewPanel(
            HistoryManager.viewType,
            `History: ${path.basename(filePath)}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [],
            },
        );

        let recordedHistoryReady = false;
        let disposed = false;
        let revision = 0;
        let session: {
            id: string;
            stream: HistoryStream;
            preview?: FileHistory;
            offset: number;
            busy: boolean;
            lastReply?: { type: string; loadId: string; offset: number };
        } | undefined;
        let statusRevision = 0;
        const updatePreparation = async () => {
            const revision = ++statusRevision;
            const text = await BlogPostManager.preparationStatus(filePath);
            if (!disposed && recordedHistoryReady && revision === statusRevision) await panel.webview.postMessage({ type: 'preparation', text });
        };
        const render = async () => {
            if (disposed) return;
            const generation = ++revision;
            session?.stream.dispose();
            session = undefined;
            recordedHistoryReady = false;
            panel.webview.html = this._getLoadingHtml(panel.webview);
            try {
                await fileWatcher.flushFile(filePath);
                const stored = await storageManager.getFileHistory(filePath);
                const recorded = Boolean(stored?.snapshots.length);
                const language = discoveredLanguage ?? stored?.language;
                if (!recorded && !language) throw new Error('파일을 찾을 수 없습니다.');
                const history = recorded ? stored! : await readSavedFileHistory(filePath, language!);
                if (disposed || generation !== revision) return;
                const id = randomBytes(16).toString('hex');
                session = { id, stream: new HistoryStream(history), preview: recorded ? undefined : history, offset: 0, busy: false };
                panel.webview.html = this._getHtmlForWebview(history, id, recorded);
            } catch {
                if (!disposed && generation === revision) panel.webview.html = '<p>기록을 불러오지 못했습니다. 파일을 확인한 뒤 다시 열어 주세요.</p>';
            }
        };

        const messages = panel.webview.onDidReceiveMessage(async (message) => {
            const current = session;
            if (disposed || !current || message.loadId !== current.id) return;
            try {
                switch (message.type) {
                    case 'ready':
                        if (current.preview) break;
                        recordedHistoryReady = true;
                        if (panel.visible) void BlogPostManager.prepareOnReview(filePath);
                        void updatePreparation().catch(() => {});
                        break;
                    case 'loadHistory': {
                        if (current.busy || message.offset !== current.offset) break;
                        const offset = current.offset;
                        current.busy = true;
                        try {
                            const entry = await current.stream.next();
                            if (disposed || session !== current || !entry) return;
                            current.lastReply = { type: 'historyEntry', loadId: current.id, offset, ...entry };
                            current.offset++;
                        } catch {
                            current.lastReply = { type: 'historyError', loadId: current.id, offset };
                        } finally {
                            current.busy = false;
                        }
                        if (!disposed && session === current && panel.visible) await panel.webview.postMessage(current.lastReply);
                        break;
                    }
                    case 'reloadHistory':
                        await render();
                        break;
                    case 'write':
                        if (recordedHistoryReady) await BlogPostManager.openPage(extensionUri, filePath);
                        break;
                    case 'viewSnapshot':
                        await this._openSnapshot(filePath, message.index, message.version, current.preview);
                        break;
                    case 'deleteSnapshot':
                        if (recordedHistoryReady && await this._handleDeleteRequest(filePath, message.index, message.version)) {
                            await render();
                        }
                        break;
                }
            } catch (error) {
                if (error instanceof HistoryConflict) {
                    void vscode.window.showInformationMessage(error.message);
                    await render();
                } else void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
            }
        });
        const preparation = BlogPostManager.onDidChange(changed => {
            if (recordedHistoryReady && changed === filePath) void updatePreparation().catch(() => {});
        });
        const visibility = panel.onDidChangeViewState(() => {
            if (!panel.visible) return;
            // A retained but suspended webview can miss its in-flight response.
            // The webview accepts only its pending offset, so replay is idempotent.
            if (session?.lastReply) void panel.webview.postMessage(session.lastReply);
            if (recordedHistoryReady) {
                void BlogPostManager.prepareOnReview(filePath);
                void updatePreparation().catch(() => {});
            }
        });
        panel.onDidDispose(() => {
            disposed = true;
            session?.stream.dispose();
            messages.dispose();
            visibility.dispose();
            preparation.dispose();
        });
        await render();
    }

    private static async _handleDeleteRequest(
        filePath: string,
        index: number,
        version: string,
    ) {
        let confirmMessage = '이 로그를 삭제하시겠습니까?';

        // Check if it's the first log (index 0) or middle log
        if (index === 0) {
            confirmMessage =
                '첫 번째 로그를 삭제하면 다음 로그가 새로운 기준점이 됩니다. 삭제하시겠습니까?';
        } else {
            // For middle logs, we can verify if it's the last one by checking history length,
            // but for simplicity, the generic warning about merging is fine or we can check here.
            const history = await storageManager.getFileHistory(filePath);
            if (history && index < history.snapshots.length - 1) {
                confirmMessage =
                    '중간 로그를 삭제하면 더 최근 로그로 수정 사항이 합쳐집니다. 삭제하시겠습니까?';
            }
        }

        const selection = await vscode.window.showWarningMessage(
            confirmMessage,
            { modal: true },
            '삭제',
        );

        if (selection !== '삭제') return false;
        await storageManager.deleteSnapshot(filePath, index, version);
        return true;
    }

    private static _getLoadingHtml(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Loading History</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-sideBar-background);
                    color: var(--vscode-foreground);
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                    margin: 0;
                }
                .spinner {
                    border: 4px solid var(--vscode-widget-border);
                    border-top: 4px solid var(--vscode-progressBar-background);
                    border-radius: 50%;
                    width: 40px;
                    height: 40px;
                    animation: spin 1s linear infinite;
                    margin-bottom: 16px;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                .text {
                    font-size: 14px;
                    opacity: 0.8;
                }
            </style>
        </head>
        <body>
            <div class="spinner"></div>
            <div class="text">기록을 불러오는 중입니다...</div>
        </body>
        </html>`;
    }

    private static async _openSnapshot(filePath: string, index: number, version: string, preview?: FileHistory) {
        const history = preview ?? await storageManager.getFileHistory(filePath);
        if (!history) {
            vscode.window.showErrorMessage('History not found.');
            return;
        }

        if (historyFingerprint(history) !== version) throw new HistoryConflict();
        let content = storageManager.reconstructFileContent(history, index);
        if (content === null) {
            vscode.window.showErrorMessage('Failed to reconstruct snapshot content.');
            return;
        }

        // Add Header Comment
        const snapshot = history.snapshots[index];
        const date = new Date(snapshot.timestamp);
        const dateStr = date.toLocaleString('en-US', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            hour12: true,
        });
        const fileName = path.basename(filePath);

        let commentPrefix = '//'; // Default (C, C++, Java, JS, TS, etc.)
        if (
            history.language === 'python' ||
            history.language === 'ruby' ||
            history.language === 'perl' ||
            history.language === 'shellscript'
        ) {
            commentPrefix = '#';
        }

        const header = `${commentPrefix} PS-Blogself History Log: ${fileName} at ${dateStr}\n\n`;
        content = header + content;

        const doc = await vscode.workspace.openTextDocument({
            content: content,
            language: history.language,
        });
        await vscode.window.showTextDocument(doc, {
            preview: true,
            viewColumn: vscode.ViewColumn.Active, // Open in active tab (full screen effect)
        });
    }

    private static _getHtmlForWebview(history: FileHistory, loadId: string, recorded: boolean): string {
        const nonce = randomBytes(24).toString('base64');
        const values: Record<string, string> = {
            title: htmlText(history.filePath), fileName: htmlText(path.basename(history.filePath)),
            total: String(history.snapshots.length), loadId, version: historyFingerprint(history), recorded: String(recorded),
            csp: `default-src 'none'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none';`,
            styles: `<style nonce="${nonce}">${historyCss}</style>`,
            script: `<script nonce="${nonce}">${historyScript}</script>`,
        };
        return historyTemplate.replace(/\{\{(\w+)\}\}/g, (_match, key) => values[key] ?? '');
    }
}
