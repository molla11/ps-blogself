const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const original = Module._load;
const uri = value => ({ fsPath: value, scheme: 'file', toString: () => value });
let workspaceFolders = [], activeFile;
const editorEvents = new EventEmitter();
Module._load = function(name, ...args) {
    if (name === 'vscode') return {
        window: {
            showWarningMessage: async () => undefined,
            get activeTextEditor() { return activeFile ? { document: { uri: uri(activeFile) } } : undefined; },
            onDidChangeActiveTextEditor(callback) { editorEvents.on('change', callback); return { dispose: () => editorEvents.off('change', callback) }; },
        },
        workspace: {
            get workspaceFolders() { return workspaceFolders; },
            getWorkspaceFolder(file) {
                return workspaceFolders.find(folder => {
                    const relative = path.relative(folder.uri.fsPath, file.fsPath);
                    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
                });
            },
        },
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
const { configManager } = require('../../src/config.ts');
const { fileWatcher } = require('../../src/storage/FileWatcher.ts');
let store, draft, settings, updates = 0;
const subscriptions = [];
let configSubscriptions = [], configContext;
const configValue = () => ({ root: configManager.getRootFolder(), currentDirectory: configManager.getCurrentDirectory(), windowRoot: configManager.isWindowRoot(), recording: configManager.isRecording(), languages: configManager.getSupportedLanguages() });
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
            case 'configInit':
                workspaceFolders = data.folders.map(folder => ({ uri: uri(folder) }));
                activeFile = data.activeFile;
                configContext = { storageUri: data.workspace ? uri(data.workspace) : undefined, globalStorageUri: uri(data.directory), globalState: { get: (_key, fallback) => fallback } };
                // Fall through to simulate activating or reloading this extension host.
            case 'configReload':
                configSubscriptions.forEach(item => item.dispose()); configSubscriptions = [];
                await configManager.init({ ...configContext, subscriptions: configSubscriptions });
                value = configValue(); break;
            case 'configValue': value = configValue(); break;
            case 'configRoot': await configManager.setRootFolder(data.path ?? configManager.getCurrentDirectory(), !!data.windowOnly); value = configValue(); break;
            case 'configRecording': await configManager.setRecording(data); break;
            case 'configLanguages': await configManager.setSupportedLanguages(data); break;
            case 'configActiveFile':
                activeFile = data;
                editorEvents.emit('change', { document: { uri: uri(activeFile) } });
                value = configValue(); break;
            case 'recordDocument':
                await fileWatcher._onDidSaveDocument({ uri: uri(data.file), fileName: data.file, languageId: 'python', isClosed: false, getText: () => data.content });
                break;
            case 'snapshots':
                await Promise.all(data.contents.map(content => storageManager.saveSnapshot({ uri: uri(data.file), languageId: 'python', getText: () => content })));
                break;
            case 'history': value = await storageManager.getFileHistory(data); break;
            case 'deleteSnapshot': await storageManager.deleteSnapshot(data.file, data.index, data.version); break;
            case 'index': value = await storageManager.getRecentFiles(); break;
            case 'close':
                subscriptions.forEach(item => item.dispose());
                configSubscriptions.forEach(item => item.dispose());
                await store.close(); break;
        }
        process.send({ id, value });
    } catch (error) { process.send({ id, error: error.message }); }
});
