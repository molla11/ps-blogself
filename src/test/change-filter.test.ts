import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { applyPatch } from 'diff';
import { isCosmeticChange } from '../writing/ChangeFilter';
import { sourceFor, writingSourceFor, preparationSource } from '../writing/model';
import { validateRequest } from '../writing/RequestValidation';
import { FileHistory } from '../types';

const preserved: [string, string, string, string][] = [
    ['identifier boundary', 'cpp', 'inta=10;', 'int a=10;'],
    ['increment boundary', 'cpp', 'a+++b;', 'a+ ++b;'],
    ['preprocessing number', 'cpp', 'int x=0xe+foo;', 'int x=0xe + foo;'],
    ['line comment', 'cpp', '// increment\n++x;', '// increment ++x;'],
    ['comment text', 'cpp', '/* try again */ int x;', '/* try  again */ int x;'],
    ['literal text', 'cpp', 'puts("a b");', 'puts("a  b");'],
    ['literal prefix', 'cpp', 'auto x=L"a";', 'auto x=L "a";'],
    ['literal suffix', 'cpp', 'auto x="a"s;', 'auto x="a" s;'],
    ['macro definition', 'cpp', '#define F(x) x\nF(1);', '#define F (x) x\nF(1);'],
    ['stringification', 'cpp', '#define S(x) #x\nS(a+b)', '#define S(x) #x\nS(a + b)'],
    ['line number', 'cpp', 'int x=__LINE__;\n', '\nint x=__LINE__;\n'],
    ['line number moved with same total lines', 'cpp', '\nint x=__LINE__;\n', 'int x=__LINE__;\n\n'],
    ['source column', 'cpp', 'int x=__builtin_COLUMN();', 'int x = __builtin_COLUMN();'],
    ['assert stringification', 'cpp', 'assert(a+b);', 'assert(a + b);'],
    ['continued comment', 'cpp', '// skip \\\n++x;', '// skip\n++x;'],
    ['directive must start a line', 'cpp', 'int x;\n#include <cstdio>\n', 'int x; #include <cstdio>\n'],
    ['directive must end a line', 'cpp', '#include <cstdio>\nint x;', '#include <cstdio> int x;'],
    ['Python backslash trailing space', 'python', 'x = 1 + \\\n    2\n', 'x = 1 + \\ \n    2\n'],
    ['Python indentation', 'python', 'if False:\n    print(1)\n', 'if False:\nprint(1)\n'],
    ['Python tab indentation', 'python', 'if True:\n\tprint(1)\n', 'if True:\n    print(1)\n'],
    ['Python token boundary', 'python', 'returnx\n', 'return x\n'],
    ['Python line boundary', 'python', 'x = 1\ny = 2\n', 'x = 1 y = 2\n'],
    ['Python string', 'python', 'print("a b")\n', 'print("a  b")\n'],
    ['Python triple string', 'python', 's="""a\n b"""\n', 's="""a\n  b"""\n'],
    ['Python f-string debug output', 'python', 'print(f"{x=}")', 'print(f"{x = }")'],
];
for (const [name, language, before, after] of preserved) {
    test(`filter preserves ${name} in both directions`, () => {
        assert.equal(isCosmeticChange(before, after, language), false);
        assert.equal(isCosmeticChange(after, before, language), false);
    });
}

const cosmetic: [string, string, string, string][] = [
    ['C declaration', 'c', 'int a=10;', 'int a = 10;'],
    ['C++ declaration', 'cpp', '#include <cstdio>\nint a=10;', '#include <cstdio>\nint a = 10;'],
    ['separate unary plus', 'cpp', 'a + +b;', 'a+ + b;'],
    ['block comment boundary', 'cpp', 'int/**/a=10;', 'int /**/ a=10;'],
    ['adjacent string literals', 'cpp', 'puts("ab" "cd");', 'puts("ab""cd");'],
    ['ordinary blank line', 'cpp', '#include <cstdio>\nint a;', '#include <cstdio>\n\nint a;'],
    ['unchanged Korean comment', 'cpp', '// 풀이\nint a=10;', '// 풀이\nint a = 10;'],
    ['Python horizontal spacing', 'python', 'if True:\n    x=1+2\n', 'if True:\n    x = 1 + 2\n'],
    ['Python trailing spaces', 'python', 'print(1)\n', 'print(1)  \n'],
    ['identical incomplete source', 'plaintext', '"unfinished', '"unfinished'],
];
for (const [name, language, before, after] of cosmetic) {
    test(`filter recognizes ${name}`, () => {
        assert.equal(isCosmeticChange(before, after, language), true);
        assert.equal(isCosmeticChange(after, before, language), true);
    });
}

test('unsupported contexts retain even harmless formatting instead of guessing', () => {
    for (const [language, before, after] of [
        ['cpp', '#define ADD(x) ((x)+1)\nADD(1)', '#define ADD(x) ((x) + 1)\nADD(1)'],
        ['cpp', '#include "helpers.h"\nF(a+b);', '#include "helpers.h"\nF(a + b);'],
        ['cpp', '#include <custom.h>\nF(a+b);', '#include <custom.h>\nF(a + b);'],
        ['cpp', 'auto s=R"(a b)";', 'auto s = R"(a b)";'],
        ['cpp', 'int 값=1;', 'int 값 = 1;'],
        ['cpp', 'puts("unfinished);', 'puts( "unfinished);'],
        ['python', 'if True:\n    x=1\n', 'if True:\n        x=1\n'],
        ['python', 'x=[\n 1,\n]\n', 'x=[\n    1,\n]\n'],
        ['python', 'print(f"{x+1}")', 'print(f"{x + 1}")'],
        ['python', 'inspect.getsource(f)', 'inspect.getsource( f )'],
        ['javascript', 'return\nx;', 'return x;'],
    ]) assert.equal(isCosmeticChange(before, after, language), false, language + ': ' + before);
});

const contents = ['int a=1;\n', 'int a = 1;\n', 'int a = 2;\n', 'int a  = 2;\n', 'int a  = 2;\n', 'int a=3;\n'];
const history: FileHistory = {
    id: 'filter-history', filePath: '/solve.cpp', language: 'cpp',
    startedAt: 1, lastModified: 6, requestLogs: [],
    snapshots: contents.map((content, index) => ({ content, timestamp: index + 1, hash: String(index) })),
};

test('compacted diff chains reconstruct every retained snapshot, including narrowed ranges', () => {
    const original = structuredClone(history);
    for (const [start, end, expected] of [[0, 5, [0, 2, 5]], [1, 4, [1, 2, 4]], [3, 3, [3]]] as const) {
        const source = writingSourceFor(history, start, end);
        assert.deepEqual(source.changes.map((c) => c.index), expected);
        let code = source.initialCode;
        for (const change of source.changes) {
            const applied = applyPatch(code, change.diff);
            assert.equal(applied, contents[change.index]);
            code = applied as string;
        }
        assert.equal(code, source.finalCode);
        assert.equal(source.finalCode, contents[end]);
    }
    assert.deepEqual(history, original);
    assert.equal(sourceFor(history).changes.length, 6); // The history UI stays complete.
    assert.deepEqual(preparationSource(history), writingSourceFor(history));
});

test('reviewed plan boundaries survive filtering and satisfy the actual request contract', () => {
    const plan = {
        title: '풀이', summary: '', start: 0, end: 5,
        steps: [{ title: '내가 선택한 구간', body: '', start: 1, end: 3 }],
    };
    const source = writingSourceFor(history, plan.start, plan.end, plan.steps.flatMap((s) => [s.start, s.end]));
    assert.deepEqual(source.changes.map((c) => c.index), [0, 1, 2, 3, 5]);
    validateRequest({ kind: 'write_blog', requestId: 'filter-test', source, plan, instructions: '' });
});

test('meaningful invalid-to-valid and backslash fixes are kept inside an actual preparation request', () => {
    const snapshots = ['inta=10;', 'int a=10;', 'int a=20;'].map((content, index) => ({ content, timestamp: index + 1, hash: String(index) }));
    const source = preparationSource({ ...history, snapshots });
    assert.deepEqual(source.changes.map((c) => c.index), [0, 1, 2]);
    const python = ['x=1+\\ \n 2\n', 'x=1+\\\n 2\n', 'x=2\n'];
    assert.equal(preparationSource({ ...history, language: 'python', snapshots: snapshots.map((s, i) => ({ ...s, content: python[i] })) }).changes.length, 3);
});
