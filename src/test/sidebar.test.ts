import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { RecentLogsPager } from '../sidebar/RecentLogsPager';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileModifiedTimes } from '../storage/FileModifiedTime';

const logs = Array.from({ length: 55 }, (_, i) => ({
    fileName: `solve${i}.cpp`, filePath: `/work/solve${i}.cpp`, language: 'cpp', lastModified: 1000 - i, fileHash: String(i),
}));

test('file dates prefer the saved snapshot, fall back to disk, and omit unavailable dates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'psb-file-dates-'));
    try {
        const file = { filePath: join(directory, 'solve.py'), language: 'python' };
        const missing = { filePath: join(directory, 'gone.cpp'), language: 'cpp' };
        const diskTime = new Date('2025-09-20T12:30:00Z');
        await writeFile(file.filePath, 'print(1)');
        await utimes(file.filePath, diskTime, diskTime);
        const times = new FileModifiedTimes();
        const history = { ...logs[0], ...file, language: 'custom', lastModified: diskTime.getTime() - 60000 };
        assert.deepEqual((await times.newestFirst([file], [history]))[0], { ...file, language: 'custom', lastModified: history.lastModified });
        assert.deepEqual(await times.newestFirst([file, missing]), [{ ...file, lastModified: diskTime.getTime() }, missing]);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recent history expands through the final page and duplicate requests do not skip files', async () => {
    const pager = new RecentLogsPager(async () => logs);
    assert.deepEqual((await pager.load()).recentLogs, logs.slice(0, 20));
    const second = await pager.load(20);
    assert.equal(second.hasMoreRecentLogs, true);
    assert.deepEqual(second.recentLogs, logs.slice(0, 40));
    assert.deepEqual((await pager.load(20)).recentLogs, second.recentLogs);
    const last = await pager.load(40);
    assert.deepEqual(last.recentLogs, logs);
    assert.equal(last.hasMoreRecentLogs, false);
    assert.deepEqual((await pager.load()).recentLogs, logs);
});

test('disk files and recordings are ranked together before preview, search and pagination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'psb-file-order-'));
    try {
        const file = { filePath: join(directory, 'solve99.py'), fileName: 'solve99.py', language: 'python', source: 'folder' as const };
        await writeFile(file.filePath, 'print(99)');
        const times = new FileModifiedTimes();
        const all = [...logs, file];
        const read = () => times.newestFirst(all);
        const pager = new RecentLogsPager(read);
        pager.setSearch('solve', 1);
        const page = await pager.load();
        assert.equal(page.recentLogs.length, 20);
        assert.equal(page.recentLogs[0].filePath, file.filePath);
        assert.equal((await read()).slice(0, 4)[0].filePath, file.filePath);
        await utimes(file.filePath, new Date(0), new Date(0));
        times.invalidate(file.filePath);
        assert.equal((await read()).at(-1)?.filePath, file.filePath);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('new and reordered records retain all loaded files without offset gaps', async () => {
    let index = [...logs];
    const pager = new RecentLogsPager(async () => index);
    await pager.load();
    const loaded = (await pager.load(20)).recentLogs;
    const added = { ...logs[0], fileName: 'new.cpp', filePath: '/work/new.cpp' };
    // The oldest loaded file is edited while another new file is recorded.
    index = [added, logs[39], ...logs.filter(log => log !== logs[39])];
    const refreshed = await pager.load();
    assert.equal(refreshed.recentLogs.length, 41);
    for (const file of loaded) assert.ok(refreshed.recentLogs.includes(file));
    assert.deepEqual(refreshed.recentLogs, index.slice(0, 41));
    const last = await pager.load(41);
    assert.deepEqual(last.recentLogs, index);
    assert.equal(last.hasMoreRecentLogs, false);
});

test('concurrent refreshes are ordered and a failed read can be retried', async () => {
    let attempts = 0;
    const pager = new RecentLogsPager(async () => {
        if (++attempts === 1) throw new Error('temporary read failure');
        return logs;
    });
    await assert.rejects(pager.load(), /temporary/);
    const pages = await Promise.all([pager.load(), pager.load(20), pager.load(40)]);
    assert.deepEqual(pages.map(page => page.recentLogs.length), [20, 40, 55]);
    assert.deepEqual(pages.map(page => page.recentLogsRevision), [1, 2, 3]);
});

test('closing a discovered tab does not expand the page to its new directory position', async () => {
    const folder = logs.map(({ filePath, fileName, language }) => ({ filePath, fileName, language, source: 'folder' as const }));
    const tab = { ...folder.at(-1)!, source: 'open' as const };
    let opened = true;
    const pager = new RecentLogsPager(async () => opened ? [tab, ...folder.slice(0, -1)] : folder);
    assert.deepEqual((await pager.load()).recentLogs[0], tab);
    opened = false;
    assert.deepEqual((await pager.load()).recentLogs, folder.slice(0, 20));
});

test('search covers the complete index by file name or path, including Unicode and literal punctuation', async () => {
    const special = { ...logs[0], fileName: '풀이[1].CPP', filePath: '/archive/알고리즘/풀이[1].CPP' };
    const pager = new RecentLogsPager(async () => [...logs, special]);
    await pager.load();
    pager.setSearch(' SOLVE54.CPP ', 1);
    assert.deepEqual((await pager.load()).recentLogs, [logs[54]]);
    pager.setSearch('/알고리즘/'.normalize('NFD'), 2);
    assert.deepEqual((await pager.load()).recentLogs, [special]);
    pager.setSearch('[1].cpp', 3);
    assert.deepEqual((await pager.load()).recentLogs, [special]);
    pager.setSearch('missing', 4);
    const empty = await pager.load();
    assert.deepEqual(empty.recentLogs, []);
    assert.equal(empty.hasMoreRecentLogs, false);
});

test('plain text matches file names without leaking matches from internal data directories', async () => {
    const files = [
        { ...logs[0], fileName: '샘플-중복제거.py', filePath: '/home/test/.vscode-server/data/User/globalStorage/psb/samples/샘플-중복제거.py' },
        { ...logs[0], fileName: 'mybot1.cpp', filePath: '/home/test/.vscode-server/data/User/globalStorage/psb/imported-files/mybot1.cpp' },
        { ...logs[0], fileName: 'Data.cpp', filePath: '/work/Data.cpp' },
    ];
    const pager = new RecentLogsPager(async () => files);
    pager.setSearch('da', 1);
    assert.deepEqual((await pager.load()).recentLogs, [files[2]]);
    pager.setSearch('/data/', 2);
    assert.deepEqual((await pager.load()).recentLogs, files.slice(0, 2));
    pager.setSearch('\\data\\', 3);
    assert.deepEqual((await pager.load()).recentLogs, files.slice(0, 2));
});

test('Windows drives, UNC shares, WSL and macOS paths accept either separator and normalized Unicode', async () => {
    const files = [
        { ...logs[0], fileName: 'MyBot.cpp', filePath: 'C:\\Users\\Tester\\Projects\\MyBot.cpp' },
        { ...logs[0], fileName: 'Remote.py', filePath: '\\\\server\\share\\solver\\Remote.py' },
        { ...logs[0], fileName: 'wsl.cpp', filePath: '/home/test/solutions/wsl.cpp' },
        { ...logs[0], fileName: '풀이.py'.normalize('NFD'), filePath: '/Users/test/문제/풀이.py'.normalize('NFD') },
    ];
    const cases: [string, typeof files][] = [
        ['c:/users/tester/projects/mybot.cpp', [files[0]]],
        ['C:\\Users\\Tester\\Projects\\MyBot.cpp', [files[0]]],
        ['/projects/mybot', [files[0]]],
        ['//SERVER/share/', [files[1]]],
        ['\\\\server\\share\\', [files[1]]],
        ['/solutions/', [files[2]]],
        ['\\solutions\\', [files[2]]],
        ['/문제/', [files[3]]],
        ['풀이', [files[3]]],
        ['Projects', []],
    ];
    const pager = new RecentLogsPager(async () => files);
    for (const [i, [query, expected]] of cases.entries()) {
        pager.setSearch(query, i + 1);
        assert.deepEqual((await pager.load()).recentLogs, expected, query);
    }
});

test('search pagination and clearing each start a fresh window, even with older reads in flight', async () => {
    const pager = new RecentLogsPager(async () => logs);
    await pager.load(20);
    const oldMore = pager.load(40);
    pager.setSearch('solve', 1);
    const search = pager.load();
    assert.equal((await oldMore).recentLogs.length, 55);
    assert.equal((await search).recentLogs.length, 20);
    assert.equal((await pager.load(20)).recentLogs.length, 40);
    const oldSearch = pager.load(40);
    pager.setSearch('', 2);
    const cleared = pager.load();
    assert.equal((await oldSearch).recentLogsSearchId, 1);
    const page = await cleared;
    assert.equal(page.recentLogsSearchId, 2);
    assert.deepEqual(page.recentLogs, logs.slice(0, 20));
    assert.equal(page.hasMoreRecentLogs, true);
    pager.setSearch('stale', 1);
    assert.deepEqual((await pager.load()).recentLogs, page.recentLogs);
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

test('folder discovery publishes a usable preview, shares ranked pages and discards a superseded scan', async () => {
    const loader = require('node:module'), original = loader._load;
    const modulePath = require.resolve('../sidebar/CodeDiscovery');
    const cached = require.cache[modulePath];
    let folder = '/first', changeFolder!: () => void;
    const disposable = () => ({ dispose() {} });
    const uri = (fsPath: string) => ({ scheme: 'file', fsPath });
    const full = deferred<ReturnType<typeof uri>[]>();
    const fullStarted = deferred<void>();
    const searches: (number | undefined)[] = [];
    const vscode = {
        EventEmitter: class { event = disposable; fire() {} dispose() {} },
        CancellationTokenSource: class { token = {}; cancel() {} dispose() {} },
        RelativePattern: class { constructor(public baseUri: unknown) {} },
        Uri: { file: uri },
        window: { tabGroups: { all: [], onDidChangeTabs: disposable }, onDidChangeActiveTextEditor: disposable },
        workspace: { onDidSaveTextDocument: disposable,
            onDidChangeWorkspaceFolders: (listener: () => void) => { changeFolder = listener; return disposable(); },
            createFileSystemWatcher: () => ({ onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable, dispose() {} }),
            findFiles: async (_scope: unknown, _exclude: unknown, limit?: number) => {
                searches.push(limit);
                if (folder === '/next') return [uri('/next/new.py')];
                if (limit) return Array.from({ length: limit }, (_, i) => uri('/first/' + i + '.cpp'));
                fullStarted.resolve(); return full.promise;
            },
        },
    };
    delete require.cache[modulePath];
    loader._load = function(name: string, ...args: unknown[]) {
        return name === 'vscode' ? vscode : original.call(this, name, ...args);
    };
    let discovery: import('../sidebar/CodeDiscovery').CodeDiscovery;
    try { discovery = new (require('../sidebar/CodeDiscovery').CodeDiscovery)(() => folder); }
    finally {
        loader._load = original;
        if (cached) require.cache[modulePath] = cached; else delete require.cache[modulePath];
    }
    try {
        discovery.start();
        await fullStarted.promise;
        assert.ok(discovery.searching && discovery.files.length >= 20);
        const history: typeof logs = [];
        const preview = await discovery.withHistory(history);
        assert.equal(preview.length, searches[0]);
        assert.equal(await discovery.currentFiles(history), preview, 'both views reuse the completed ranking');
        folder = '/next'; changeFolder();
        await discovery.whenScanFinishes();
        full.resolve([uri('/first/stale.cpp')]);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual((await discovery.withHistory(history)).map(file => file.filePath), ['/next/new.py']);
        assert.deepEqual(searches, [searches[0], undefined, searches[0]], 'a small workspace is scanned only once');
    } finally { full.resolve([]); discovery.dispose(); }
});

function sidebarHarness(read: () => Promise<typeof logs>, size: () => Promise<string>, account = async () => 'reader@example.test') {
    const Module = require('node:module');
    const original = Module._load;
    const file = require.resolve('../sidebar/SidebarProvider');
    const cached = require.cache[file];
    const mocks: Record<string, unknown> = {
        vscode: { window: { activeTextEditor: { document: { uri: { fsPath: '/work/solve0.cpp' } } } },
            workspace: { workspaceFolders: [{ uri: { fsPath: '/work' } }] } },
        '../config': { configManager: {
            getRootFolder: () => '/work', getCurrentDirectory: () => '/work', isWindowRoot: () => false,
            isRecording: () => true, getSupportedLanguages: () => ['cpp'],
        } },
        '../storage/StorageManager': { storageManager: { getRecentFiles: read, calculateTotalSize: size } },
        './getSidebarHtml': {},
        '../services/HistoryManager': {},
        '../services/BlogPostManager': { BlogPostManager: { accountLabel: account, usage: async () => undefined, notices: async () => [] } },
    };
    delete require.cache[file];
    Module._load = function(name: string, parent: { filename: string }, ...args: unknown[]) {
        if (parent?.filename === file && Object.hasOwn(mocks, name)) return mocks[name];
        return original.call(this, name, parent, ...args);
    };
    try {
        const { SidebarProvider } = require('../sidebar/SidebarProvider');
        const noop = () => {};
        const provider: import('../sidebar/SidebarProvider').SidebarProvider = new SidebarProvider({}, noop, noop, noop, noop, noop, { withHistory: (files: unknown[]) => files });
        (provider as any).writingLogs = async (logs: unknown[]) => logs;
        const messages: any[] = [];
        (provider as any)._view = { visible: true, webview: { postMessage: async (message: unknown) => { messages.push(message); return true; } } };
        return { provider, messages };
    } finally {
        Module._load = original;
        if (cached) require.cache[file] = cached; else delete require.cache[file];
    }
}

test('saved records reach the sidebar before storage-size and account lookups finish', async () => {
    const size = deferred<string>(), account = deferred<string>();
    const { provider, messages } = sidebarHarness(async () => logs, () => size.promise, () => account.promise);
    const refresh = provider.updateState();
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(messages.map(message => message.type), ['updateState', 'recentLogsPage']);
        assert.equal(messages[0].hasFolder, true);
        assert.deepEqual(messages[1].recentLogs, logs.slice(0, 20));
        assert.equal(messages[1].activeFile, '/work/solve0.cpp');
        size.resolve('10 KB');
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(messages.at(-1).totalLogSize, '10 KB', 'storage size arrives independently of account state');
    } finally {
        size.resolve('10 KB'); account.resolve('reader@example.test');
        await refresh;
    }
    assert.equal(messages.at(-1).accountLabel, 'reader@example.test');
});

test('rapid saves publish each new page while stale background state is discarded', async () => {
    const firstSize = deferred<string>(), secondSize = deferred<string>();
    let index = logs.slice(0, 1), sizes = 0;
    const { provider, messages } = sidebarHarness(async () => index, () => ++sizes === 1 ? firstSize.promise : secondSize.promise);
    const first = provider.updateState();
    await new Promise<void>(resolve => setImmediate(resolve));
    index = [logs[1], logs[0]];
    const second = provider.updateState();
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        const pages = messages.filter(message => message.type === 'recentLogsPage');
        assert.equal(pages.length, 2);
        assert.deepEqual(pages[1].recentLogs, index);
        assert.ok(pages[1].recentLogsRevision > pages[0].recentLogsRevision);
        secondSize.resolve('20 KB');
        await second;
    } finally {
        firstSize.resolve('10 KB'); secondSize.resolve('20 KB');
        await Promise.all([first, second]);
    }
    assert.deepEqual(messages.filter(message => message.type === 'storageSize').map(message => message.totalLogSize), ['20 KB']);
});

test('a hidden sidebar defers reading the file and history indexes', async () => {
    const { provider, messages } = sidebarHarness(async () => assert.fail('hidden list read'), async () => assert.fail('hidden storage scan'));
    (provider as any)._view.visible = false;
    await provider.updateState();
    assert.deepEqual(messages, []);
});

test('service polling refreshes notices and usage while the window and sidebar are inactive, then stops on disposal', t => {
    const disposed = () => ({ dispose() {} });
    let usage = 0, notices = 0, tick!: () => void, onFocus!: () => void;
    const disposeCallbacks: (() => void)[] = [];
    const manager = { onDidChange: disposed, onDidChangeControls: disposed, setSidebarVisible() {}, refreshUsage: async () => { usage++; }, refreshNotices: async () => { notices++; } };
    const mocks: Record<string, unknown> = {
        vscode: { window: { state: { focused: false }, onDidChangeWindowState: (listener: () => void) => { onFocus = listener; return disposed(); }, onDidChangeActiveTextEditor: disposed },
            workspace: { onDidChangeWorkspaceFolders: disposed } },
        '../config': { configManager: { onDidChange: disposed } },
        '../storage/StorageManager': { storageManager: { onDidUpdateIndex: disposed } },
        './getSidebarHtml': { getSidebarHtml: () => '' },
        '../services/HistoryManager': { HistoryManager: { onDidChangeActive: disposed } },
        '../services/BlogPostManager': { BlogPostManager: manager },
    };
    const loader = require('node:module'), original = loader._load;
    let Provider: typeof import('../sidebar/SidebarProvider').SidebarProvider;
    loader._load = function(name: string, ...args: unknown[]) { return mocks[name] || original.call(this, name, ...args); };
    try { Provider = require('../sidebar/SidebarProvider').SidebarProvider; }
    finally { loader._load = original; }
    t.mock.method(globalThis, 'setInterval', (callback: () => void, delay: number) => {
        assert.equal(delay, 30000); tick = callback;
        return { unref() {} } as NodeJS.Timeout;
    });
    const clear = t.mock.method(globalThis, 'clearInterval', () => {});
    const provider = new Provider!({} as any, () => {}, () => {}, () => {}, () => {}, () => {}, { onDidChange: disposed } as any);
    provider.resolveWebviewView({ visible: false, webview: { onDidReceiveMessage() {}, options: {}, html: '' },
        onDidDispose: (callback: () => void) => { disposeCallbacks.push(callback); return disposed(); }, onDidChangeVisibility: disposed } as any, {} as any, {} as any);
    tick(); tick();
    assert.equal(usage, 2); assert.equal(notices, 2);
    onFocus();
    assert.equal(usage, 3); assert.equal(notices, 3);
    disposeCallbacks.forEach(dispose => dispose());
    assert.equal(clear.mock.callCount(), 1);
});
