import * as fs from 'fs/promises';

const MAX_COUNTED_BYTES = 64 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8000;
const NEWLINE = 0x0a;

export interface FileMeasure {
    bytes: number;
    modifiedAt: number;
    lines: number | null;
}

function countLines(content: Buffer): number | null {
    if (content.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
        return null;
    }
    let lines = 0;
    for (let index = content.indexOf(NEWLINE); index >= 0; index = content.indexOf(NEWLINE, index + 1)) {
        lines++;
    }
    return content.length > 0 && content[content.length - 1] !== NEWLINE ? lines + 1 : lines;
}

export async function measureFile(absolutePath: string, previous: FileMeasure | undefined): Promise<FileMeasure | null> {
    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) {
        return null;
    }
    if (previous && previous.bytes === stat.size && previous.modifiedAt === stat.mtimeMs) {
        return previous;
    }
    const lines = stat.size > MAX_COUNTED_BYTES ? null : countLines(await fs.readFile(absolutePath));
    return { bytes: stat.size, modifiedAt: stat.mtimeMs, lines };
}
