import { Hunk, RangeHunk } from '../types';

const TRACE_BUDGET = 4_000_000;

export function splitSegments(content: string): string[] {
    const segments: string[] = [];
    let start = 0;
    let index = content.indexOf('\n');
    while (index >= 0) {
        segments.push(content.slice(start, index + 1));
        start = index + 1;
        index = content.indexOf('\n', start);
    }
    if (start < content.length) {
        segments.push(content.slice(start));
    }
    return segments;
}

export function joinSegments(segments: readonly string[]): string {
    return segments.join('');
}

export function firstLineIndex(start: number, lines: number): number {
    return lines > 0 ? start - 1 : start;
}

function rangeStart(index: number, lines: number): number {
    return lines > 0 ? index + 1 : index;
}

function replaceHunk(oldIndex: number, oldLines: number, newIndex: number, newLines: number): RangeHunk {
    return {
        oldStart: rangeStart(oldIndex, oldLines),
        oldLines,
        newStart: rangeStart(newIndex, newLines),
        newLines,
    };
}

function snakeMatches(a: readonly string[], b: readonly string[]): Array<[number, number]> | null {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    const offset = max + 1;
    const maxD = Math.min(max, Math.floor(TRACE_BUDGET / (max + 1)));
    const v = new Int32Array(2 * max + 3);
    const trace: Int32Array[] = [];
    for (let d = 0; d <= maxD; d++) {
        trace.push(v.slice(offset - d - 1, offset + d + 2));
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                return backtrack(a.length, b.length, d, trace);
            }
        }
    }
    return null;
}

function backtrack(n: number, m: number, depth: number, trace: readonly Int32Array[]): Array<[number, number]> {
    const matches: Array<[number, number]> = [];
    let x = n;
    let y = m;
    for (let d = depth; d > 0; d--) {
        const previous = trace[d];
        const at = (k: number): number => previous[k + d + 1];
        const k = x - y;
        const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
        const previousK = down ? k + 1 : k - 1;
        const previousX = at(previousK);
        const previousY = previousX - previousK;
        const snakeX = down ? previousX : previousX + 1;
        while (x > snakeX && y > snakeX - k) {
            x--;
            y--;
            matches.push([x, y]);
        }
        x = previousX;
        y = previousY;
    }
    while (x > 0 && y > 0) {
        x--;
        y--;
        matches.push([x, y]);
    }
    return matches.reverse();
}

export function diffSegments(a: readonly string[], b: readonly string[]): RangeHunk[] {
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
        suffix++;
    }
    const middleA = a.slice(prefix, a.length - suffix);
    const middleB = b.slice(prefix, b.length - suffix);
    if (middleA.length === 0 && middleB.length === 0) {
        return [];
    }
    const matches = middleA.length === 0 || middleB.length === 0 ? [] : snakeMatches(middleA, middleB);
    if (matches === null) {
        return [replaceHunk(prefix, middleA.length, prefix, middleB.length)];
    }
    const hunks: RangeHunk[] = [];
    let oldIndex = 0;
    let newIndex = 0;
    for (const [matchOld, matchNew] of [...matches, [middleA.length, middleB.length] as [number, number]]) {
        if (matchOld > oldIndex || matchNew > newIndex) {
            hunks.push(replaceHunk(prefix + oldIndex, matchOld - oldIndex, prefix + newIndex, matchNew - newIndex));
        }
        oldIndex = matchOld + 1;
        newIndex = matchNew + 1;
    }
    return hunks;
}

function stripLineEnd(segment: string): string {
    return segment.endsWith('\n') ? segment.slice(0, -1) : segment;
}

export function toHunk(a: readonly string[], b: readonly string[], range: RangeHunk): Hunk {
    const oldIndex = firstLineIndex(range.oldStart, range.oldLines);
    const newIndex = firstLineIndex(range.newStart, range.newLines);
    const removed = a.slice(oldIndex, oldIndex + range.oldLines);
    const added = b.slice(newIndex, newIndex + range.newLines);
    return {
        ...range,
        removedLines: removed.map(stripLineEnd),
        addedLines: added.map(stripLineEnd),
        removedNoNewlineAtEof: removed.length > 0 && oldIndex + removed.length === a.length && !a[a.length - 1].endsWith('\n'),
        addedNoNewlineAtEof: added.length > 0 && newIndex + added.length === b.length && !b[b.length - 1].endsWith('\n'),
    };
}

export function spliceSegments(base: readonly string[], source: readonly string[], hunks: readonly RangeHunk[]): string[] {
    const ordered = [...hunks].sort((x, y) => firstLineIndex(x.oldStart, x.oldLines) - firstLineIndex(y.oldStart, y.oldLines));
    const segments: string[] = [];
    let cursor = 0;
    for (const hunk of ordered) {
        const oldIndex = firstLineIndex(hunk.oldStart, hunk.oldLines);
        const newIndex = firstLineIndex(hunk.newStart, hunk.newLines);
        segments.push(...base.slice(cursor, oldIndex));
        segments.push(...source.slice(newIndex, newIndex + hunk.newLines));
        cursor = Math.max(cursor, oldIndex + hunk.oldLines);
    }
    segments.push(...base.slice(cursor));
    return segments;
}

export function invertHunk(hunk: RangeHunk): RangeHunk {
    return { oldStart: hunk.newStart, oldLines: hunk.newLines, newStart: hunk.oldStart, newLines: hunk.oldLines };
}

export function mapNewIndexToOld(relation: readonly RangeHunk[], newIndex: number): number {
    let shift = 0;
    for (const hunk of relation) {
        const start = firstLineIndex(hunk.newStart, hunk.newLines);
        if (start + hunk.newLines > newIndex || (hunk.newLines === 0 && start >= newIndex)) {
            break;
        }
        shift += hunk.oldLines - hunk.newLines;
    }
    return newIndex + shift;
}
