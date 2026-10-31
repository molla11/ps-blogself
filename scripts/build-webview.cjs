const esbuild = require('esbuild');
const { resolve } = require('node:path');

exports.buildWebview = async (entry) => esbuild.build({
    entryPoints: [entry], bundle: true, write: false, platform: 'browser',
    format: 'iife', target: 'chrome120', minify: true, metafile: true,
    legalComments: 'inline',
});

exports.webviewPlugin = {
    name: 'webview-bundle',
    setup(build) {
        build.onLoad({ filter: /\.webview\.js$/ }, async ({ path }) => {
            const result = await exports.buildWebview(path);
            return {
                contents: `export default ${JSON.stringify(result.outputFiles[0].text)};`,
                loader: 'js', watchFiles: Object.keys(result.metafile.inputs).map(file => resolve(file)),
            };
        });
    },
};
