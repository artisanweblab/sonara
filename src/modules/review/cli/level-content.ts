import { CONTENT_ENCODING } from '../model/segment-codec';

export interface EncodedContent {
    encoding: 'utf-8' | 'base64';
    bytes: number;
    content: string;
}

export function contentBytes(content: string): Buffer {
    return Buffer.from(content, CONTENT_ENCODING);
}

export function encodeContent(content: string): EncodedContent {
    const bytes = contentBytes(content);
    try {
        return { encoding: 'utf-8', bytes: bytes.length, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
        return { encoding: 'base64', bytes: bytes.length, content: bytes.toString('base64') };
    }
}
