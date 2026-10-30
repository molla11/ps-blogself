import { MAX_CODE_BYTES, utf8Bytes } from '../writing/InputLimits';

// UTF-8 bytes are never fewer than UTF-16 units. Avoid materializing a huge
// editor document before computing its exact byte size.
export function limitedSnapshotText(characterLength: number | undefined, read: () => string): string | undefined {
    if (characterLength !== undefined && characterLength > MAX_CODE_BYTES) return;
    const content = read();
    return utf8Bytes(content) <= MAX_CODE_BYTES ? content : undefined;
}
