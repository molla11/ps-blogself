// Define minimal interface to avoid ESM import issues in CJS environment
interface MinimalHighlighter {
    codeToHtml(code: string, options: any): string;
}

export class ShikiService {
    private static _instance: ShikiService;
    private _highlighter: MinimalHighlighter | null = null;
    private _readyPromise: Promise<void> | null = null;

    private constructor() {}

    public static getInstance(): ShikiService {
        if (!ShikiService._instance) {
            ShikiService._instance = new ShikiService();
        }
        return ShikiService._instance;
    }

    public async init() {
        if (this._highlighter) return;
        if (this._readyPromise) return this._readyPromise;

        this._readyPromise = (async () => {
            const { createHighlighter } = await import('shiki');
            this._highlighter = await createHighlighter({
                themes: ['github-dark', 'github-light', 'vitesse-dark', 'vitesse-light'],
                langs: [
                    'javascript',
                    'typescript',
                    'python',
                    'cpp',
                    'c',
                    'java',
                    'html',
                    'css',
                    'json',
                    'shell',
                    'bash',
                    'ruby',
                    'go',
                    'rust',
                    'markdown',
                ],
            });
        })();
        return this._readyPromise;
    }

    public getHighlighter(): MinimalHighlighter {
        if (!this._highlighter) {
            throw new Error('Shiki not initialized');
        }
        return this._highlighter;
    }

    public async highlight(
        code: string,
        lang: string,
        theme: string = 'github-dark',
    ): Promise<string> {
        await this.init();
        if (!this._highlighter) return code;

        try {
            return this._highlighter.codeToHtml(code, {
                lang,
                theme,
            });
        } catch (e) {
            console.error('Shiki highlight error:', e);
            return `<pre><code>${code}</code></pre>`; // Fallback
        }
    }
}
