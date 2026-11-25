import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { BackgroundRecorder } from '../storage/BackgroundRecorder';

const Module = require('node:module');
const listeners: Record<string, (...args: any[]) => any> = {};
const event = (key: string) => (callback: (...args: any[]) => any, context?: unknown) => {
    listeners[key] = callback.bind(context);
    return { dispose: () => { delete listeners[key]; } };
};
let recording = true;
const saved: string[] = [];
const original = Module._load;
Module._load = function(name: string, ...args: any[]) {
    if (name === 'vscode') {
        return {
            TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 },
            workspace: { textDocuments: [], onDidOpenTextDocument: event('open'), onWillSaveTextDocument: event('willSave'), onDidSaveTextDocument: event('save'), onDidChangeTextDocument: event('change'), onDidCloseTextDocument: event('close') },
            window: { onDidChangeActiveTextEditor: event('editor'), onDidChangeWindowState: event('focus') },
        };
    }
    if (name === '../config') return { configManager: { isRecording: () => recording, getRootFolder: () => '', getSupportedLanguages: () => ['cpp'], onDidChange: event('config') } };
    if (name === './StorageManager') return { storageManager: { saveSnapshot: async (doc: any) => { saved.push(doc.getText()); }, flush: async () => {} } };
    return original.call(this, name, ...args);
};
const { FileWatcher } = require('../storage/FileWatcher');
Module._load = original;
function setup() {
    saved.length = 0; recording = true;
    const watcher = new FileWatcher(), subscriptions: { dispose(): void }[] = [];
    watcher.init({ subscriptions });
    let text = '';
    const document = { uri: { scheme: 'file', fsPath: '/work/2527.cpp', toString: () => '/work/2527.cpp' }, fileName: '/work/2527.cpp', isClosed: false, getText: () => text };
    return { watcher, document,
        edit(value: string) { text = value; listeners.change({ document, contentChanges: [{}] }); },
        async save(reason: number) { listeners.willSave({ document, reason }); await listeners.save(document); },
        dispose() { subscriptions.forEach(item => item.dispose()); },
    };
}

test('frequent autosaves coalesce until idle while continuous editing records by 30 seconds', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = setup();
    for (let i = 0; i < 6; i++) { f.edit(`v${i}`); await f.save(2); t.mock.timers.tick(5000); }
    assert.deepEqual(saved, ['v5']);
    f.edit('final'); await f.save(2); t.mock.timers.tick(9999);
    assert.deepEqual(saved, ['v5']);
    t.mock.timers.tick(1);
    assert.deepEqual(saved, ['v5', 'final']);
    f.dispose();
});

test('rapid manual saves and focus-out saves preserve every explicit checkpoint', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = setup();
    for (const content of ['a', 'ab', 'abc']) { f.edit(content); await f.save(1); }
    f.edit('def'); await f.save(3);
    t.mock.timers.tick(30000);
    assert.deepEqual(saved, ['a', 'ab', 'abc', 'def']);
    f.dispose();
});

test('file switches, closing and shutdown flush pending edits; disabled recording discards them', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = setup();
    listeners.editor({ document: f.document }); f.edit('switch'); listeners.editor(undefined);
    f.edit('close'); f.document.isClosed = true; listeners.close(f.document); f.document.isClosed = false;
    f.edit('shutdown'); await f.watcher.flush();
    f.edit('disabled'); recording = false; listeners.config(); t.mock.timers.tick(30000);
    assert.deepEqual(saved, ['switch', 'close', 'shutdown']);
    f.dispose();
});

test('independent files have independent idle windows and repeated flushes do not duplicate a version', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const writes: string[] = [];
    const recorder = new BackgroundRecorder<string>(async value => { writes.push(value); });
    recorder.change('a', 'a1'); t.mock.timers.tick(5000); recorder.change('b', 'b1');
    t.mock.timers.tick(5000); assert.deepEqual(writes, ['a1']);
    await recorder.flushAll(); await recorder.flushAll(); t.mock.timers.tick(30000);
    assert.deepEqual(writes, ['a1', 'b1']);
});
