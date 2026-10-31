require('./register-typescript.cjs');
const path = require('node:path');
const { loadConnectionEnvironment, resolveConnectionSettings, requireBackend } = require('../src/writing/ConnectionSettings.ts');
async function checkBackend() {
    const development = await loadConnectionEnvironment(path.resolve(__dirname, '..'), true);
    const { apiUrl } = resolveConnectionSettings(process.env, development);
    await requireBackend(apiUrl);
    console.log('백엔드 연결 확인: ' + apiUrl);
}
checkBackend().catch(error => { console.error(error.message); process.exitCode = 1; });
