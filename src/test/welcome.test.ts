import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { WelcomeState } from '../welcome/WelcomeState';

async function temporary(action: (directory: string) => Promise<void>) {
    const directory = await mkdtemp(path.join(tmpdir(), 'psb-welcome-'));
    try { await action(directory); }
    finally { await rm(directory, { recursive: true, force: true }); }
}

test('welcome appears once across restarts, while a separate profile gets its own first run', () => temporary(async directory => {
    let opened = 0;
    assert.equal(await new WelcomeState(directory).showOnce(() => { opened++; }), true);
    assert.equal(await new WelcomeState(directory).showOnce(() => { opened++; }), false);
    assert.equal(opened, 1);
    assert.equal(await new WelcomeState(path.join(directory, 'other-profile')).showOnce(() => { opened++; }), true);
    assert.equal(opened, 2);
}));

test('a failed panel creation does not consume the first-run welcome', () => temporary(async directory => {
    const state = new WelcomeState(directory);
    await assert.rejects(state.showOnce(() => { throw new Error('panel unavailable'); }), /panel unavailable/);
    assert.equal(await state.showOnce(() => {}), true);
    assert.equal(await state.showOnce(() => { assert.fail('already seen'); }), false);
}));

test('two extension host processes cannot both open the first-run welcome', () => temporary(async directory => {
    const script = `const { WelcomeState } = require('./src/welcome/WelcomeState.ts');
        new WelcomeState(process.argv[1]).showOnce(() => process.stdout.write('opened')).catch(error => { console.error(error); process.exitCode = 1; });`;
    const results = await Promise.all([0, 1].map(() => promisify(execFile)(process.execPath,
        ['--require', path.resolve('scripts/register-typescript.cjs'), '-e', script, directory], { cwd: process.cwd() })));
    assert.deepEqual(results.map(result => result.stdout).sort(), ['', 'opened']);
}));
