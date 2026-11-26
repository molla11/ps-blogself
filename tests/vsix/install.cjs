const { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
    const vsix = path.resolve(process.argv[2]);
    const executable = process.env.VSCODE_EXECUTABLE || await downloadAndUnzipVSCode();
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ps-blogself-install-'));
    const profileArgs = ['--user-data-dir', path.join(profile, 'user'), '--extensions-dir', path.join(profile, 'extensions')];
    try {
        execFileSync(resolveCliPathFromVSCodeExecutablePath(executable), [...profileArgs, '--install-extension', vsix], { stdio: 'inherit' });
        await runTests({
            vscodeExecutablePath: executable,
            extensionDevelopmentPath: __dirname,
            extensionTestsPath: path.join(__dirname, 'welcome.cjs'),
            extensionTestsEnv: { PSB_API_URL: 'http://127.0.0.1:1/api' },
            launchArgs: [...profileArgs, '--disable-gpu'],
        });
    } finally {
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
