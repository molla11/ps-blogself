const spawn = require('cross-spawn');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
// The installed VS Code CLI launches an Extension Development Host. --wait
// lets closing that window also stop the build watchers in this terminal.
const editor = spawn('code', ['--new-window', '--wait', '--extensionDevelopmentPath=' + root, ...process.argv.slice(2)], {
    cwd: root, stdio: 'inherit',
});
const watcher = spawn('pnpm', ['watch'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
});
let stopping = false;
watcher.stdout.on('data', (data) => { if (!stopping) process.stdout.write(data); });
watcher.stderr.on('data', (data) => { if (!stopping) process.stderr.write(data); });
function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    if (watcher.pid) {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(watcher.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            try { process.kill(-watcher.pid, 'SIGTERM'); } catch { /* already stopped */ }
        }
    }
    editor.kill();
    process.exitCode = code;
}
editor.on('error', () => {
    console.error('VS Code의 code 명령을 찾을 수 없습니다. VS Code에서 이 폴더를 열고 F5를 누르거나 code 명령을 PATH에 추가해 주세요.');
    stop(1);
});
watcher.on('error', (error) => { console.error(error.message); stop(1); });
editor.on('exit', (code) => stop(code || 0));
watcher.on('exit', (code) => { if (!stopping) stop(code || 1); });
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log('개발 창에서 작업 폴더를 열어 사용하세요. 소스 변경은 자동 빌드됩니다. 확장 코드를 적용하려면 개발 창에서 Reload Window를 실행하세요.');
