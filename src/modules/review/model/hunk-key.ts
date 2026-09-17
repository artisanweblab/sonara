import { createHash } from 'crypto';
import { Hunk } from '../types';

export const CONTEXT_LINE_COUNT = 3;

const SEPARATOR = '\0';
const NO_NEWLINE_MARKER = '\\ No newline at end of file';

export interface HunkContext {
    before: string[];
    after: string[];
}

function sha256(parts: string[]): string {
    return createHash('sha256').update(parts.join(SEPARATOR), 'utf8').digest('hex');
}

function sideText(lines: string[], noNewlineAtEof: boolean): string {
    const joined = lines.join('\n');
    return noNewlineAtEof ? `${joined}\n${NO_NEWLINE_MARKER}` : joined;
}

export function splitWorkingLines(content: string): string[] {
    const lines = content.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

export function hunkContext(hunk: Hunk, workingLines: string[]): HunkContext {
    const linesBefore = hunk.newLines > 0 ? hunk.newStart - 1 : hunk.newStart;
    const beforeStart = Math.max(0, linesBefore - CONTEXT_LINE_COUNT);
    const afterStart = linesBefore + hunk.newLines;
    return {
        before: workingLines.slice(beforeStart, Math.max(beforeStart, linesBefore)),
        after: workingLines.slice(afterStart, afterStart + CONTEXT_LINE_COUNT),
    };
}

export function hunkKey(filePath: string, hunk: Hunk, context: HunkContext): string {
    return sha256([
        filePath,
        sideText(hunk.removedLines, hunk.removedNoNewlineAtEof),
        sideText(hunk.addedLines, hunk.addedNoNewlineAtEof),
        context.before.join('\n'),
        context.after.join('\n'),
    ]);
}
