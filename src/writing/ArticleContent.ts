import MarkdownIt = require('markdown-it');
import { ArticleDocument, documentFromMarkdown, documentText, validateDocument } from './ArticleDocument';

/** Recover drafts saved while the title and its display divider were Lexical blocks. */
export function separateArticleTitle<T extends { title?: string; markdown?: string; document?: ArticleDocument | null }>(article: T): T {
    if (!article.document?.titleInDocument) return article;
    const document = validateDocument(article.document);
    const children = [...document.root.children!];
    const first = children[0];
    const title = first?.type === 'heading' && first.tag === 'h1' ? documentText(children.shift()!) : article.title;
    let markdown = article.markdown || '';
    if (children[0]?.type === 'article-divider') {
        children.shift();
        // The stored Markdown already omits the title. Remove only the matching
        // leading divider, keeping code fences, whitespace and body dividers intact.
        const token = new MarkdownIt({ html: false }).parse(markdown, {})[0];
        if (token?.type === 'hr' && token.map) markdown = markdown.split('\n').slice(token.map[1]).join('\n').replace(/^(?:[ \t]*\r?\n)+/, '');
    }
    return { ...article, title: article.title ?? title ?? '', markdown, document: {
        version: 1, root: { ...document.root, children: children.length ? children : documentFromMarkdown('').root.children },
    } };
}
