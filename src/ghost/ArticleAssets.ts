import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { ArticleDocument, ArticleNode, validateDocument } from '../writing/ArticleDocument';

export class ArticleAssets {
    constructor(readonly directory: string) {}
    private id(src: string) { if (!/^psb-image:[a-f0-9]{64}$/.test(src)) throw new Error('이미지 참조가 올바르지 않습니다.'); return src.slice(10); }
    file(src: string) { return path.join(this.directory, this.id(src)); }
    async put(bytes: Buffer): Promise<string> {
        imageMime(bytes);
        const src = 'psb-image:' + createHash('sha256').update(bytes).digest('hex');
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFile(this.file(src), bytes, { mode: 0o600 });
        return src;
    }
    async read(src: string) { const bytes = await readFile(this.file(src)); return { bytes, mime: imageMime(bytes) }; }
    async dataUrl(src: string) { const { bytes, mime } = await this.read(src); return `data:${mime};base64,${bytes.toString('base64')}`; }
}
export function imageMime(bytes: Buffer): string {
    if (bytes.length > 10 * 1024 * 1024) throw new Error('이미지는 10MB 이하로 추가해 주세요.');
    if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
    if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
    throw new Error('PNG·JPEG·WebP·GIF 이미지 파일만 사용할 수 있습니다.');
}
export function imageRefs(doc: ArticleDocument): string[] {
    const refs = new Set<string>();
    const visit = (node: ArticleNode) => { if (node.type === 'article-image') refs.add(node.src); node.children?.forEach(visit); }; visit(doc.root); return [...refs];
}
export async function mapImages(doc: ArticleDocument, resolve: (src: string) => Promise<string>): Promise<ArticleDocument> {
    const result = validateDocument(doc), refs = imageRefs(result), sources = new Map<string, string>();
    // A small fixed worker pool keeps large documents responsive on low-memory hosts.
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(3, refs.length) }, async () => { while (index < refs.length) { const src = refs[index++]; sources.set(src, await resolve(src)); } }));
    const visit = (node: ArticleNode) => { if (node.type === 'article-image') node.src = sources.get(node.src)!; node.children?.forEach(visit); }; visit(result.root); return result;
}
