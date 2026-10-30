// A deliberately small lexical check, not a parser or a proof of equivalent programs.
// Unknown syntax/context is kept. In particular, never strip all whitespace first:
// inta -> int a, a+++b -> a+ ++b and 0xe+foo -> 0xe + foo change tokens.
const cppOperators = /^(?:>>=|<<=|<=>|->\*|\.\.\.|::|\.\*|->|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||\+=|-=|\*=|\/=|%=|\^=|&=|\|=|[{}()[\];:?.~!+\-*/%<>=^&|,])/;
const pythonOperators = /^(?:\*\*=|\/\/=|>>=|<<=|\.\.\.|\*\*|\/\/|<<|>>|<=|>=|==|!=|:=|->|\+=|-=|\*=|\/=|%=|@=|&=|\|=|\^=|[{}()[\];:.~+\-*/%<>=^&|,@])/;
const identifier = /^[A-Za-z_][A-Za-z_0-9]*/;
// Preprocessing numbers use maximal munch, including exponent signs and separators.
const number = /^(?:[0-9]|\.[0-9])(?:[eEpP][+-]|[A-Za-z_0-9.]|'[A-Za-z_0-9])*/;
const cppString = /^(?:u8|u|U|L)?(?:"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*')(?:[A-Za-z_][A-Za-z_0-9]*)?/;
const pythonString = /^(?:br|rb|r|b|u)?(?:"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*')/i;
// External headers may define whitespace-sensitive macros. Only recognize these
// common standard headers; other includes and all other directives retain edits.
const standardHeaders = new Set([
    'bits/stdc++.h', 'algorithm', 'array', 'bit', 'bitset', 'cmath', 'complex',
    'cstdio', 'cstdlib', 'cstring', 'deque', 'functional', 'iomanip', 'ios',
    'iostream', 'iterator', 'limits', 'list', 'map', 'memory', 'numeric', 'optional',
    'queue', 'random', 'set', 'sstream', 'stack', 'string', 'string_view', 'tuple',
    'type_traits', 'unordered_map', 'unordered_set', 'utility', 'vector',
    'math.h', 'stdio.h', 'stdlib.h', 'string.h', 'stdint.h', 'stddef.h', 'limits.h',
]);

function tokens(code: string, python: boolean): string[] | undefined {
    // Splicing runs before C++ comment handling. Python requires the backslash
    // immediately before the newline, so even one trailing space can be a fix.
    if (/\\[ \t]*\r?\n/.test(code)) return;
    if (python) {
        // Keep complex strings and source introspection without attempting to
        // implement Python's version-dependent f/t-string grammar here.
        if (/'''|"""|\b(?:fr|rf|f|tr|rt|t)["']|\b(?:inspect|linecache|traceback|__code__|__file__)\b/i.test(code)) return;
    } else if (/\?\?|<:|:>|<%|%>|%:|\b(?:u8|u|U|L)?R"/.test(code)) {
        return; // Raw strings, trigraphs and digraphs need a fuller lexer.
    }
    const result: string[] = [];
    let offset = 0;
    while (offset < code.length) {
        const rest = code.slice(offset);
        const space = /^[ \t]+/.exec(rest)?.[0];
        if (space) {
            // Preserve Python physical indentation, even inside brackets.
            if (python && (offset === 0 || code[offset - 1] === '\n')) result.push(space);
            offset += space.length;
            continue;
        }
        const newline = /^(?:\r\n|\n)/.exec(rest)?.[0];
        if (newline) {
            if (python) result.push(newline);
            offset += newline.length;
            continue;
        }
        let token: string | undefined;
        if ((!python && rest.startsWith('//')) || (python && rest.startsWith('#'))) {
            token = /^[^\r\n]*/.exec(rest)![0];
        } else if (!python && rest.startsWith('/*')) {
            const end = rest.indexOf('*/', 2);
            if (end < 0) return;
            token = rest.slice(0, end + 2);
        } else if (!python && rest.startsWith('#')) {
            // Preserve directive text and its newline; #define F(x) and F (x)
            // differ, as do arguments passed through # stringification.
            if (!/^[ \t]*$/.test(code.slice(code.lastIndexOf('\n', offset - 1) + 1, offset))) return;
            const include = /^#include[ \t]*<([^>\r\n]+)>[ \t]*(?:\r?\n|$)/.exec(rest);
            if (!include || !standardHeaders.has(include[1])) return;
            token = include[0];
        } else {
            token = (python ? pythonString : cppString).exec(rest)?.[0]
                || number.exec(rest)?.[0]
                || identifier.exec(rest)?.[0]
                || (python ? pythonOperators : cppOperators).exec(rest)?.[0];
            if (!token) return; // Incomplete literals, Unicode identifiers, etc.
            if (!python && /^(?:__LINE__|__FILE__|__COUNTER__|__builtin_LINE|__builtin_COLUMN|source_location|assert|import|module)$/.test(token)) return;
        }
        result.push(token);
        offset += token.length;
    }
    return result;
}

/** Only a positive result permits omitting an intermediate AI-input snapshot. */
export function isCosmeticChange(before: string, after: string, language: string): boolean {
    if (before === after) return true;
    if (!['c', 'cpp', 'python'].includes(language)) return false;
    const left = tokens(before, language === 'python');
    if (!left) return false;
    const right = tokens(after, language === 'python');
    return !!right && left.length === right.length && left.every((token, index) => token === right[index]);
}
