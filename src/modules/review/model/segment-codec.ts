import { joinSegments, splitSegments } from './line-diff';

export const CONTENT_ENCODING = 'latin1';

export function toSegments(content: Buffer | null): string[] {
    return splitSegments((content ?? Buffer.alloc(0)).toString(CONTENT_ENCODING));
}

export function toBuffer(segments: readonly string[]): Buffer {
    return Buffer.from(joinSegments(segments), CONTENT_ENCODING);
}
