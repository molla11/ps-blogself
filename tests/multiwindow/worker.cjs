const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const original = Module._load;
const uri = value => ({ fsPath: value, scheme: 'file', toString: () => value });
Module._load = function(name, ...args) {
    if (name === 'vscode') return {
        window: { showWarningMessage: async () => undefined },
        Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
        EventEmitter: class {
            constructor() { this.emitter = new EventEmitter(); this.event = callback => { this.emitter.on('event', callback); return { dispose: () => this.emitter.off('event', callback) }; }; }
            fire(value) { this.emitter.emit('event', value); }
        },
    };
    return original.call(this, name, ...args);
};
const { DraftStore } = require('../../src/writing/DraftStore.ts');
const { newDraft } = require('../../src/writing/model.ts');
const { WorkspaceSettings } = require('../../src/storage/WorkspaceSettings.ts');
const { storageManager } = require('../../src/storage/StorageManager.ts');
let store, draft, settings, updates = 0;
const subscriptions = [];
process.on('message', async ({ id, action, data }) => {
    try {
        let value;
        switch (action) {
            case 'init':
                store = new DraftStore(path.join(data.directory, data.draftDirectory || 'drafts'));
                settings = new WorkspaceSettings(path.join(data.workspace, 'settings.json'));
                await settings.init();
                subscriptions.push(settings.watch(() => { updates++; }));
                storageManager.init({ globalStorageUri: uri(data.directory), subscriptions });
                break;
            case 'claim': draft = await store.open(newDraft(data.history), !!data.takeover); value = { draft, editable: store.owns(draft) }; break;
            case 'edit': Object.assign(draft, data); await store.save(draft); value = draft; break;
            case 'read': value = await store.read(data); break;
            case 'release': await store.release(data); break;
            case 'settingsValue': value = { ...settings.value, updates }; break;
            case 'workspace':
                settings = new WorkspaceSettings(path.join(data, 'settings.json'));
                await settings.init(); subscriptions.push(settings.watch(() => { updates++; })); break;
            case 'settings':
                if (data) await settings.update(value => Object.assign(value, data));
                await settings.init(); value = settings.value; break;
            case 'snapshots':
                await Promise.all(data.contents.map(content => storageManager.saveSnapshot({ uri: uri(data.file), languageId: 'python', getText: () => content })));
                break;
            case 'history': value = await storageManager.getFileHistory(data); break;
            case 'deleteSnapshot': await storageManager.deleteSnapshot(data.file, data.index, data.version); break;
            case 'index': value = await storageManager.getRecentFiles(); break;
            case 'close':
                subscriptions.forEach(item => item.dispose());
                await store.close(); break;
        }
        process.send({ id, value });
    } catch (error) { process.send({ id, error: error.message }); }
});
