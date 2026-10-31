import { createHighlighterCoreSync } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import cpp from 'shiki/langs/cpp.mjs';
import python from 'shiki/langs/python.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import json from 'shiki/langs/json.mjs';
import bash from 'shiki/langs/bash.mjs';
import diff from 'shiki/langs/diff.mjs';
import light from 'shiki/themes/github-light.mjs';
import dark from 'shiki/themes/github-dark.mjs';

let highlighter;
const cache = new Map();
const aliases = { 'c++': 'cpp', py: 'python', js: 'javascript', ts: 'typescript', sh: 'bash', shell: 'bash' };
function codeTokens(source, language) {
    language = language.trim().toLowerCase();
    language = aliases[language] || language;
    if (!source || !language || ['text', 'plaintext', 'txt'].includes(language)) return [];
    const key = language + '\0' + source;
    if (cache.has(key)) return cache.get(key);
    let tokens = [];
    try {
        highlighter ||= createHighlighterCoreSync({
            langs: [cpp, python, javascript, typescript, json, bash, diff],
            themes: [light, dark], engine: createJavaScriptRegexEngine(),
        });
        if (highlighter.getLoadedLanguages().includes(language)) {
            tokens = highlighter.codeToTokens(source, {
                lang: language, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false,
            }).tokens.flat().filter(token => token.content).map(token => ({
                start: token.offset, end: token.offset + token.content.length,
                light: token.htmlStyle['--shiki-light'], dark: token.htmlStyle['--shiki-dark'],
            }));
        }
    } catch { /* Unsupported grammars remain readable as plain code. */ }
    if (cache.size >= 32) cache.delete(cache.keys().next().value);
    cache.set(key, tokens);
    return tokens;
}

// Lexical can represent line breaks as either text or <br>. Keep both in the
// source offsets without changing its DOM, selection, history or saved document.
function codeText(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    const segments = [];
    let source = '', node;
    while ((node = walker.nextNode())) {
        if (node.nodeType === Node.TEXT_NODE) {
            const start = source.length;
            source += node.textContent;
            segments.push({ node, start, end: source.length });
        } else if (node.nodeName === 'BR') source += '\n';
    }
    return { source, segments };
}

export function observeCodeHighlighting(root) {
    if (!globalThis.CSS?.highlights || !globalThis.Highlight) return () => {};
    const selector = '.prose-editor .code-block, .article-preview pre > code';
    const palette = new Map(), blocks = new Map();
    const style = document.createElement('style');
    style.nonce = document.querySelector('script[nonce]')?.nonce || '';
    document.head.appendChild(style);
    let frame;
    function color(token) {
        const key = token.light + '/' + token.dark;
        if (!palette.has(key)) {
            const name = 'psb-code-' + palette.size, highlight = new Highlight();
            style.sheet.insertRule(`::highlight(${name}) { color: ${token.light}; }`, style.sheet.cssRules.length);
            style.sheet.insertRule(`:is(.vscode-dark, .vscode-high-contrast) ::highlight(${name}) { color: ${token.dark}; }`, style.sheet.cssRules.length);
            CSS.highlights.set(name, highlight);
            palette.set(key, { name, highlight });
        }
        return palette.get(key).highlight;
    }
    function render() {
        frame = undefined;
        const present = new Set(root.querySelectorAll(selector));
        let changed = false;
        for (const block of blocks.keys()) {
            if (!present.has(block)) { blocks.delete(block); changed = true; }
        }
        for (const block of present) {
            const language = block.getAttribute('data-language') || [...block.classList].find(name => name.startsWith('language-'))?.slice(9) || '';
            const { source, segments } = codeText(block), previous = blocks.get(block);
            if (previous?.source === source && previous.language === language &&
                // Moving an intact DOM block can collapse its live ranges into
                // the old parent. Rebuild those ranges even if the text is unchanged.
                previous.ranges.every(({ range }) => !range.collapsed && block.contains(range.startContainer) && block.contains(range.endContainer)) &&
                previous.segments.length === segments.length && segments.every((segment, index) => {
                    const old = previous.segments[index];
                    return old.node === segment.node && old.start === segment.start && old.end === segment.end;
                })) continue;
            const ranges = [];
            let index = 0;
            for (const token of codeTokens(source, language)) {
                while (index < segments.length && segments[index].end <= token.start) index++;
                for (let cursor = index; cursor < segments.length && segments[cursor].start < token.end; cursor++) {
                    const segment = segments[cursor];
                    if (segment.end <= segment.start) continue;
                    const range = new Range();
                    range.setStart(segment.node, Math.max(token.start, segment.start) - segment.start);
                    range.setEnd(segment.node, Math.min(token.end, segment.end) - segment.start);
                    ranges.push({ range, highlight: color(token) });
                }
            }
            blocks.set(block, { source, language, segments, ranges });
            changed = true;
        }
        if (changed) {
            for (const { highlight } of palette.values()) highlight.clear();
            for (const { ranges } of blocks.values()) {
                for (const { highlight, range } of ranges) highlight.add(range);
            }
        }
    }
    const observer = new MutationObserver(() => {
        if (frame === undefined) frame = requestAnimationFrame(render);
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-language'] });
    render();
    return () => {
        observer.disconnect();
        if (frame !== undefined) cancelAnimationFrame(frame);
        for (const { name } of palette.values()) CSS.highlights.delete(name);
        style.remove();
    };
}
