import * as vscode from 'vscode';
import { configManager } from './config';

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'psb.sidebar';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _onSelectRootFolder: () => void,
        private readonly _onClearRootFolder: () => void,
        private readonly _onUseWorkspaceRoot: () => void,
        private readonly _onToggleRecording: () => void,
        private readonly _onToggleLanguage: (lang: string) => void,
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'selectRootFolder': {
                    this._onSelectRootFolder();
                    break;
                }
                case 'clearRootFolder': {
                    this._onClearRootFolder();
                    break;
                }
                case 'useWorkspaceRoot': {
                    this._onUseWorkspaceRoot();
                    break;
                }
                case 'toggleRecording': {
                    this._onToggleRecording();
                    break;
                }
                case 'toggleLanguage': {
                    this._onToggleLanguage(data.value);
                    break;
                }
                case 'getInitialData': {
                    this.updateState();
                    break;
                }
            }
        });
    }

    public updateState() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'updateState',
                root: configManager.getRootFolder(),
                isRecording: configManager.isRecording(),
                languages: configManager.getSupportedLanguages(),
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>PS-Blogself</title>
                <style>
                    :root {
                        --container-padding: 10px;
                        --border-radius: 4px;
                        --item-margin: 8px;
                    }

                    body {
                        padding: var(--container-padding);
                        color: var(--vscode-foreground);
                        font-family: var(--vscode-font-family);
                        font-size: var(--vscode-font-size);
                        line-height: 1.3;
                        background-color: var(--vscode-sideBar-background);
                    }

                    .config-box {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        background: var(--vscode-editor-background);
                        padding: 8px 10px;
                        border-radius: var(--border-radius);
                        border: 1px solid var(--vscode-widget-border);
                        margin-bottom: var(--item-margin);
                    }

                    .config-box.vertical {
                        flex-direction: column;
                        align-items: flex-start;
                        gap: 8px;
                    }

                    .config-info {
                        display: flex;
                        flex-direction: column;
                        gap: 2px;
                    }

                    .config-title {
                        font-weight: 700;
                        font-size: 0.75rem;
                        opacity: 0.9;
                    }

                    .config-subtitle {
                        font-size: 0.8rem;
                        opacity: 0.6;
                    }

                    /* Toggle Switch */
                    .switch {
                        position: relative;
                        display: inline-block;
                        width: 30px;
                        height: 16px;
                    }

                    .switch input {
                        opacity: 0;
                        width: 0;
                        height: 0;
                    }

                    .slider {
                        position: absolute;
                        cursor: pointer;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background-color: #ccc;
                        transition: .2s;
                        border-radius: 16px;
                    }

                    .slider:before {
                        position: absolute;
                        content: "";
                        height: 12px;
                        width: 12px;
                        left: 2px;
                        bottom: 2px;
                        background-color: white;
                        transition: .2s;
                        border-radius: 50%;
                    }

                    input:checked + .slider {
                        background-color: var(--vscode-button-background);
                    }

                    input:checked + .slider:before {
                        transform: translateX(14px);
                    }

                    /* Language Chips */
                    .language-group {
                        display: flex;
                        gap: 4px;
                    }

                    .lang-chip {
                        padding: 2px 8px;
                        border-radius: 10px;
                        font-size: 0.7rem;
                        font-weight: 600;
                        cursor: pointer;
                        border: 1px solid var(--vscode-widget-border);
                        background: var(--vscode-sideBar-background);
                        opacity: 0.5;
                        transition: all 0.1s;
                    }

                    .lang-chip.active {
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border-color: transparent;
                        opacity: 1;
                    }

                    /* Path status */
                    .current-status {
                        padding: 8px 10px;
                        background: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-widget-border);
                        border-radius: var(--border-radius);
                        margin-bottom: var(--item-margin);
                    }

                    .status-title {
                        font-size: 0.65rem;
                        font-weight: 700;
                        margin-bottom: 4px;
                        opacity: 0.5;
                    }

                    .status-value {
                        word-break: break-all;
                        font-family: var(--vscode-editor-font-family);
                        font-size: 0.7rem;
                        padding: 4px 6px;
                        background: var(--vscode-textBlockQuote-background);
                        border-radius: 3px;
                        border: 1px solid var(--vscode-textBlockQuote-border);
                        margin-left: 0;
                    }

                    .current-status .button-group {
                        margin-top: 10px;
                        margin-bottom: 0;
                    }

                    .button-group {
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                    }

                    button {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        width: 100%;
                        padding: 4px 8px;
                        cursor: pointer;
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        border-radius: 3px;
                        font-weight: 600;
                        font-size: 0.75rem;
                        height: 24px;
                        transition: filter 0.1s;
                    }

                    button:hover {
                        filter: brightness(1.1);
                    }

                    .secondary {
                        background-color: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                    }

                    .icon {
                        font-size: 0.9rem;
                        flex-shrink: 0;
                    }

                    .hint {
                        margin-top: 8px;
                        font-size: 0.65rem;
                        opacity: 0.4;
                        display: flex;
                        gap: 4px;
                    }
                </style>
			</head>
			<body>
                <div class="config-box">
                    <div class="config-info">
                        <span class="config-title">기록 상태</span>
                        <span id="recording-status-text" class="config-subtitle">대기 중</span>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="recording-toggle">
                        <span class="slider"></span>
                    </label>
                </div>

                <div class="config-box vertical">
                    <div class="config-info">
                        <span class="config-title">대상 확장자</span>
                        <span id="lang-status-text" class="config-subtitle">현재: .c, .cpp, .py</span>
                    </div>
                    <div class="language-group">
                        <div class="lang-chip" data-lang="c">C</div>
                        <div class="lang-chip" data-lang="cpp">C++</div>
                        <div class="lang-chip" data-lang="py">Python</div>
                    </div>
                </div>

                <div class="current-status">
                    <div class="status-title">활성 경로</div>
                    <div id="root-folder-display" class="status-value">로딩 중...</div>
                    <div class="button-group">
                        <button id="clear-folder-btn" class="secondary">
                            <span class="icon">🌐</span>
                            <span>전체 디렉토리</span>
                        </button>
                        <button id="use-ws-root-btn" class="secondary">
                            <span class="icon">📂</span>
                            <span>현재 디렉토리</span>
                        </button>
                        <button id="select-folder-btn" class="secondary">
                            <span class="icon">🖱️</span>
                            <span>사용자 지정</span>
                        </button>
                    </div>
                </div>
                
                <div class="hint">
                    <span>💡</span>
                    <span>활성 경로 하위의 파일 수정만을 기록합니다.</span>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    
                    const rootDisplay = document.getElementById('root-folder-display');
                    const recordingToggle = document.getElementById('recording-toggle');
                    const recordingStatusText = document.getElementById('recording-status-text');
                    const langStatusText = document.getElementById('lang-status-text');
                    const langChips = document.querySelectorAll('.lang-chip');

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'updateState':
                                rootDisplay.textContent = message.root || '전체 워크스페이스';
                                recordingToggle.checked = message.isRecording;
                                recordingStatusText.textContent = message.isRecording ? '기록 중' : '중지됨';
                                recordingStatusText.style.color = message.isRecording ? 'var(--vscode-charts-green)' : 'inherit';
                                
                                langChips.forEach(chip => {
                                    const lang = chip.getAttribute('data-lang');
                                    if (message.languages.includes(lang)) {
                                        chip.classList.add('active');
                                    } else {
                                        chip.classList.remove('active');
                                    }
                                });

                                const order = ['c', 'cpp', 'py'];
                                const enabledLangs = message.languages
                                    .slice()
                                    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
                                    .map(l => '.' + l)
                                    .join(', ');
                                langStatusText.textContent = enabledLangs ? \`(현재: \${enabledLangs})\` : '(필터링 없음)';
                                break;
                        }
                    });

                    recordingToggle.addEventListener('change', () => {
                        vscode.postMessage({ type: 'toggleRecording' });
                    });

                    langChips.forEach(chip => {
                        chip.addEventListener('click', () => {
                            vscode.postMessage({ 
                                type: 'toggleLanguage', 
                                value: chip.getAttribute('data-lang') 
                            });
                        });
                    });

                    document.getElementById('use-ws-root-btn').addEventListener('click', () => {
                        vscode.postMessage({ type: 'useWorkspaceRoot' });
                    });

                    document.getElementById('select-folder-btn').addEventListener('click', () => {
                        vscode.postMessage({ type: 'selectRootFolder' });
                    });

                    document.getElementById('clear-folder-btn').addEventListener('click', () => {
                        vscode.postMessage({ type: 'clearRootFolder' });
                    });

                    // 초기 데이터 요청
                    vscode.postMessage({ type: 'getInitialData' });
                </script>
			</body>
			</html>`;
    }
}
