import { renderArticlePreview } from './articleImages.webview.js';
const MarkdownIt = require('markdown-it');
const markdown = new MarkdownIt({ html: false, breaks: true });

export function bindAuthorNotices() {
    const widget = document.getElementById('author-notices');
    const toggle = document.getElementById('notice-toggle');
    const panel = document.getElementById('notice-panel');
    let pinned = false;

    function show(open) {
        panel.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (!open) pinned = false;
    }
    widget.addEventListener('pointerenter', event => {
        if (event.pointerType === 'mouse') show(true);
    });
    widget.addEventListener('pointerleave', () => {
        if (!pinned && !panel.contains(document.activeElement)) show(false);
    });
    toggle.addEventListener('click', () => {
        pinned = !pinned;
        show(pinned);
    });
    widget.addEventListener('focusout', event => {
        if (event.relatedTarget && !widget.contains(event.relatedTarget)) show(false);
    });
    document.addEventListener('pointerdown', event => {
        if (!panel.hidden && !widget.contains(event.target)) show(false);
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || panel.hidden) return;
        if (panel.contains(document.activeElement)) toggle.focus();
        show(false);
    });

    const rendered = new WeakMap();
    function group(id, title, notices, fixLabel) {
        const section = document.getElementById(id);
        const key = JSON.stringify([title, notices]);
        if (rendered.get(section) === key) return;
        rendered.set(section, key);
        section.hidden = !notices.length;
        section.querySelector('h2').textContent = title;
        const list = section.querySelector('div');
        list.replaceChildren();
        for (const notice of notices) {
            const entry = document.createElement('details');
            entry.open = true;
            const summary = document.createElement('summary');
            renderArticlePreview(summary, markdown.renderInline(notice.title));
            summary.prepend((notice.source === 'code' ? '코드' : '메모') + ' · ');
            entry.append(summary);
            if (notice.detail) {
                const detail = document.createElement('div');
                renderArticlePreview(detail, markdown.render(notice.detail));
                entry.append(detail);
            }
            if (notice.appliedFix) {
                const fix = document.createElement('div');
                renderArticlePreview(fix, markdown.render(notice.appliedFix));
                const label = document.createElement('strong');
                label.textContent = fixLabel;
                fix.prepend(label);
                entry.append(fix);
            }
            list.append(entry);
        }
    }
    return (title, notices = [], fixLabel, candidate = []) => {
        group('document-notices', title, notices, fixLabel);
        group('candidate-notices', '새 결과의 알림', candidate, '반영한 수정');
        const count = notices.length + candidate.length;
        document.getElementById('notice-count').textContent = String(count);
        widget.hidden = !count;
        if (!count) show(false);
    };
}
