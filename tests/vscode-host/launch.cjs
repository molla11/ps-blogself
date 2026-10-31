const { runTests } = require('@vscode/test-electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
require('../../scripts/register-typescript.cjs');
const { requireBackend, serviceUrl } = require('../../src/writing/ConnectionSettings.ts');
async function main() {
    const root = path.resolve(__dirname, '../..');
    const apiUrl = serviceUrl(process.env.PSB_API_URL || 'http://127.0.0.1:4011/api');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(apiUrl).hostname)) throw new Error('통합 테스트에는 별도로 실행한 로컬 테스트 백엔드가 필요합니다.');
    await requireBackend(apiUrl);
    const inspectRequests = async () => {
        const response = await fetch(apiUrl.replace(/\/api$/, '') + '/__test/requests', { redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('통합 테스트용 백엔드를 실행해 주세요. 일반 서비스에서는 테스트를 실행하지 않습니다.');
        const requests = await response.json();
        if (!Array.isArray(requests)) throw new Error('테스트 서버 응답을 확인해 주세요.');
        return requests;
    };
    if ((await inspectRequests()).length) throw new Error('테스트 백엔드를 다시 시작한 뒤 실행해 주세요.');
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'ps-blogself-host-'));
    const workspace = path.join(sandbox, 'workspace');
    await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'solve.py'), 'print(1)\n');
    await fs.writeFile(
        path.join(workspace, '.vscode/settings.json'),
        JSON.stringify({
            'security.workspace.trust.enabled': false,
            'workbench.startupEditor': 'none',
            'window.restoreWindows': 'none',
            'window.dialogStyle': 'custom',
            'telemetry.telemetryLevel': 'off',
            'update.mode': 'none',
        }),
    );
    const net = require('node:net'),
        listener = net.createServer();
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const cdpPort = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    {
        for (const stage of ['first', 'restart']) {
            await runTests({
                vscodeExecutablePath: process.env.VSCODE_EXECUTABLE,
                extensionDevelopmentPath: root,
                extensionTestsPath: path.join(__dirname, 'server-suite.cjs'),
                extensionTestsEnv: {
                    PSB_HOST_SANDBOX: sandbox,
                    PSB_HOST_STAGE: stage,
                    PSB_CDP_PORT: String(cdpPort),
                    PSB_API_URL: apiUrl,
                },
                launchArgs: [
                    workspace,
                    `--remote-debugging-port=${cdpPort}`,
                    '--user-data-dir',
                    path.join(sandbox, 'profile'),
                    '--extensions-dir',
                    path.join(sandbox, 'extensions'),
                    '--disable-extensions',
                    '--disable-workspace-trust',
                    '--skip-welcome',
                    '--skip-release-notes',
                    '--no-sandbox',
                    '--disable-gpu',
                ],
            });
        }
        const requests = await inspectRequests();
        if (requests.length !== 3)
            throw new Error(
                'Reopening unexpectedly generated another paid job: ' + requests.length,
            );
        if (requests[0].source.changes.length !== 2 || requests[0].source.finalCode !== 'print(1 + 2 + 3)\n') throw new Error('Rapid saves were not preserved');
        await fs.writeFile(path.join(sandbox, 'requests.json'), JSON.stringify(requests, null, 2));
        console.log('HOST_TEST_ARTIFACTS=' + sandbox);
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
