import * as crypto from 'crypto';

export function getHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

export function generateUUID(): string {
    return crypto.randomUUID();
}
