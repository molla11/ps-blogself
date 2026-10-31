import { DecoratorNode, $applyNodeReplacement } from 'lexical';
import { safeArticleUrl } from '../../writing/ArticleDocument';

let imageSources = {};
export function setImageSources(sources) { imageSources = sources || {}; }
export class ArticleImageNode extends DecoratorNode {
    static getType() { return 'article-image'; }
    static clone(node) { return new ArticleImageNode(node.__src, node.__alt, node.__caption, node.__key); }
    constructor(src = '', alt = '', caption = '', key) { super(key); this.__src = src; this.__alt = alt; this.__caption = caption; }
    static importJSON(node) { return new ArticleImageNode(node.src, node.alt, node.caption); }
    exportJSON() { return { type: 'article-image', version: 1, src: this.__src, alt: this.__alt, caption: this.__caption }; }
    createDOM() {
        const figure = document.createElement('figure'); figure.className = 'article-image';
        const img = document.createElement('img');
        const src = imageSources[this.__src] || safeArticleUrl(this.__src, true);
        if (src && !src.startsWith('psb-image:')) img.src = src;
        img.alt = this.__alt; img.draggable = false; figure.appendChild(img);
        if (this.__caption) { const caption = document.createElement('figcaption'); caption.textContent = this.__caption; figure.appendChild(caption); }
        return figure;
    }
    setContent(src, alt, caption) { const node = this.getWritable(); node.__src = src; node.__alt = alt; node.__caption = caption; }
    updateDOM(previous) { return previous.__src !== this.__src || previous.__alt !== this.__alt || previous.__caption !== this.__caption; }
    decorate() { return null; }
    isInline() { return false; }
    getTextContent() { return this.__alt; }
}
export const $createArticleImageNode = (src, alt = '', caption = '') => $applyNodeReplacement(new ArticleImageNode(src, alt, caption));
export class ArticleDividerNode extends DecoratorNode {
    static getType() { return 'article-divider'; }
    static clone(node) { return new ArticleDividerNode(node.__key); }
    static importJSON() { return new ArticleDividerNode(); }
    exportJSON() { return { type: 'article-divider', version: 1 }; }
    createDOM() { return document.createElement('hr'); }
    updateDOM() { return false; }
    decorate() { return null; }
    isInline() { return false; }
}
