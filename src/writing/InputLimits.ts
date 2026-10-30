// Mirrored in ps-blogself/src/writing/InputLimits.ts; keep the policy identical.
export const MAX_CODE_BYTES = 512 * 1024;
export const MAX_DIFF_BYTES = 1024 * 1024;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 3 * 1024 * 1024;
export const MAX_CHANGES = 400;
export const MAX_RECONSTRUCTED_BYTES = 4 * 1024 * 1024;
export const utf8Bytes = (value: string) => Buffer.byteLength(value, 'utf8');
export class InputSizeError extends Error {
    readonly code = 'INPUT_TOO_LARGE';
    readonly status = 413;
}
export function checkInputSize(request: {
    source: { initialCode: string; finalCode: string; changes: { diff: string }[] };
}): void {
    const source = request.source;
    if (utf8Bytes(source.initialCode) > MAX_CODE_BYTES || utf8Bytes(source.finalCode) > MAX_CODE_BYTES) {
        throw new InputSizeError('코드 파일은 UTF-8 기준 512KiB 이하여야 합니다. 파일 크기나 선택한 기록을 확인해 주세요.');
    }
    if (source.changes.length > MAX_CHANGES || source.changes.some(c => utf8Bytes(c.diff) > MAX_DIFF_BYTES) ||
        utf8Bytes(JSON.stringify(source)) > MAX_SOURCE_BYTES || utf8Bytes(JSON.stringify(request)) > MAX_REQUEST_BYTES) {
        throw new InputSizeError('선택한 기록이 너무 큽니다. 더 짧은 구간을 선택해 주세요.');
    }
}
