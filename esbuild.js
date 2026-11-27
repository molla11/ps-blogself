const esbuild = require('esbuild');
const fs = require('node:fs/promises');
const { webviewOptions, webviewPlugin } = require('./scripts/build-webview.cjs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',

    setup(build) {
        build.onStart(() => {
            console.log('[watch] build started');
        });
        build.onEnd((result) => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            console.log('[watch] build finished');
        });
    },
};

async function main() {
    await fs.mkdir('media/codicons', { recursive: true });
    for (const file of ['codicon.css', 'codicon.ttf']) {
        await fs.copyFile(`node_modules/@vscode/codicons/dist/${file}`, `media/codicons/${file}`);
    }
    await fs.copyFile('node_modules/@vscode/codicons/LICENSE', 'media/codicons/LICENSE');
    const host = await esbuild.context({
        entryPoints: { extension: 'src/extension.ts', ShikiService: 'src/services/ShikiService.ts' },
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outdir: 'dist',
        external: ['vscode'],
        logLevel: 'silent',
        plugins: [
            webviewPlugin,
            {
                name: 'lazy-history-highlighter',
                setup(build) {
                    build.onResolve({ filter: /^\.\/ShikiService\.js$/ }, ({ path }) => ({ path, external: true }));
                },
            },
            /* add to the end of plugins array */
            esbuildProblemMatcherPlugin,
        ],
        loader: {
            '.html': 'text',
            '.css': 'text',
        },
    });
    const writer = await esbuild.context({
        ...webviewOptions, entryPoints: ['src/services/templates/blogPostMainScripts.webview.js'],
        outfile: 'dist/webviews/writer.js',
    });
    const builds = [host, writer];
    if (watch) await Promise.all(builds.map(build => build.watch()));
    else {
        try { await Promise.all(builds.map(build => build.rebuild())); }
        finally { await Promise.all(builds.map(build => build.dispose())); }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
