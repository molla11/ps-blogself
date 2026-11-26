const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');
const vscode = require('vscode');
const manifest = require('../../package.json');

exports.run = async () => {
    const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
    assert.ok(extension, 'VSIX must be installed');
    assert.equal(extension.packageJSON.version, manifest.version);
    await extension.activate();
    await vscode.commands.executeCommand('psb.welcome');
    const welcomeIsOpen = () => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'Welcome · PS-Blogself'));
    const deadline = Date.now() + 10000;
    while (!welcomeIsOpen() && Date.now() < deadline) await sleep(100);
    assert.ok(welcomeIsOpen(), 'The installed extension must open Welcome');
};
