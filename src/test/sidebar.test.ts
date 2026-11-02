import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { RecentLogsPager } from '../sidebar/RecentLogsPager';

const logs = Array.from({ length: 55 }, (_, i) => ({
    fileName: `solve${i}.cpp`, filePath: `/work/solve${i}.cpp`, language: 'cpp', lastModified: 1000 - i, fileHash: String(i),
}));

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

function sidebarHarness(read: () => Promise<typeof logs>, size: () => Promise<string>, account = async () => 'reader@example.test') {
    const Module = require('node:module');
    const original = Module._load;
    const file = require.resolve('../sidebar/SidebarProvider');
    const cached = require.cache[file];
    const mocks: Record<string, unknown> = {
        vscode: { window: { activeTextEditor: { document: { uri: { fsPath: '/work/solve0.cpp' } } } } },
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
        const provider: import('../sidebar/SidebarProvider').SidebarProvider = new SidebarProvider({}, noop, noop, noop, noop, noop);
        const messages: any[] = [];
        (provider as any)._view = { webview: { postMessage: async (message: unknown) => { messages.push(message); return true; } } };
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
        assert.equal(messages.length, 1);
        assert.equal(messages[0].type, 'recentLogsPage');
        assert.deepEqual(messages[0].recentLogs, logs.slice(0, 20));
        assert.equal(messages[0].activeFile, '/work/solve0.cpp');
        assert.equal(messages[0].requestId, undefined);
        size.resolve('10 KB');
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(messages.length, 1, 'the file list does not wait for the still-pending account lookup');
    } finally {
        size.resolve('10 KB'); account.resolve('reader@example.test');
        await refresh;
    }
    assert.equal(messages[1].type, 'updateState');
    assert.equal(messages[1].totalLogSize, '10 KB');
    assert.equal(messages[1].accountLabel, 'reader@example.test');
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
        assert.deepEqual(messages.map(message => message.type), ['recentLogsPage', 'recentLogsPage']);
        assert.deepEqual(messages[1].recentLogs, index);
        assert.ok(messages[1].recentLogsRevision > messages[0].recentLogsRevision);
        secondSize.resolve('20 KB');
        await second;
    } finally {
        firstSize.resolve('10 KB'); secondSize.resolve('20 KB');
        await Promise.all([first, second]);
    }
    assert.equal(messages.length, 3);
    assert.equal(messages[2].type, 'updateState');
    assert.equal(messages[2].totalLogSize, '20 KB');
    assert.deepEqual(messages[2].recentLogs, index);
});
