import { LineRange, RangeHunk } from '../types';
import { diffSegments, spliceSegments } from './line-diff';
import { rangesOverlap } from './range-overlap';

function oldRange(hunk: RangeHunk): LineRange {
    return { start: hunk.oldStart, lines: hunk.oldLines };
}

function touches(hunks: readonly RangeHunk[], hunk: RangeHunk): boolean {
    return hunks.some(link => rangesOverlap(oldRange(link), oldRange(hunk)));
}

export function restoreUnstagedSegments(base: readonly string[], index: readonly string[], head: readonly string[], worktree: readonly string[]): readonly string[] {
    const fromBase = diffSegments(index, base);
    if (fromBase.length === 0) {
        return index;
    }
    const staged = diffSegments(index, head);
    const unstaged = diffSegments(index, worktree);
    const restored = fromBase.filter(hunk => !touches(staged, hunk) && touches(unstaged, hunk));
    return restored.length === 0 ? index : spliceSegments(index, base, restored);
}

export function restoreUnstagedState(base: string, index: string, head: string, worktree: string): string {
    return index !== base && index === head && worktree !== index ? base : index;
}
