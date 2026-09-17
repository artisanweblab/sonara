import { firstLineIndex } from '../model/line-diff';
import { RangeHunk } from '../types';

const CONTEXT_LINES = 3;
const NO_NEWLINE = '\\ No newline at end of file';

interface DiffGroup {
    hunks: RangeHunk[];
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
}

function withoutLineEnd(segment: string): string {
    return segment.endsWith('\n') ? segment.slice(0, -1) : segment;
}

export class UnifiedDiff {
    static render(repoPath: string, before: readonly string[], after: readonly string[], hunks: readonly RangeHunk[]): string {
        if (hunks.length === 0) {
            return '';
        }
        const lines = [`--- a/${repoPath}`, `+++ b/${repoPath}`];
        for (const group of UnifiedDiff.group(hunks, before.length, after.length)) {
            lines.push(UnifiedDiff.header(group));
            lines.push(...UnifiedDiff.body(group, before, after));
        }
        return `${lines.join('\n')}\n`;
    }

    private static group(hunks: readonly RangeHunk[], oldLength: number, newLength: number): DiffGroup[] {
        const groups: DiffGroup[] = [];
        for (const hunk of hunks) {
            const oldIndex = firstLineIndex(hunk.oldStart, hunk.oldLines);
            const newIndex = firstLineIndex(hunk.newStart, hunk.newLines);
            const open = groups[groups.length - 1];
            if (open && oldIndex - open.oldEnd <= CONTEXT_LINES * 2) {
                open.hunks.push(hunk);
                open.oldEnd = oldIndex + hunk.oldLines;
                open.newEnd = newIndex + hunk.newLines;
                continue;
            }
            groups.push({
                hunks: [hunk],
                oldStart: oldIndex,
                oldEnd: oldIndex + hunk.oldLines,
                newStart: newIndex,
                newEnd: newIndex + hunk.newLines,
            });
        }
        return groups.map(group => ({
            ...group,
            oldStart: Math.max(0, group.oldStart - CONTEXT_LINES),
            oldEnd: Math.min(oldLength, group.oldEnd + CONTEXT_LINES),
            newStart: Math.max(0, group.newStart - CONTEXT_LINES),
            newEnd: Math.min(newLength, group.newEnd + CONTEXT_LINES),
        }));
    }

    private static header(group: DiffGroup): string {
        const oldCount = group.oldEnd - group.oldStart;
        const newCount = group.newEnd - group.newStart;
        const oldStart = oldCount > 0 ? group.oldStart + 1 : group.oldStart;
        const newStart = newCount > 0 ? group.newStart + 1 : group.newStart;
        return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
    }

    private static body(group: DiffGroup, before: readonly string[], after: readonly string[]): string[] {
        const lines: string[] = [];
        const emit = (marker: string, segments: readonly string[], index: number, count: number, total: number): void => {
            for (let offset = 0; offset < count; offset++) {
                const segment = segments[index + offset];
                lines.push(`${marker}${withoutLineEnd(segment)}`);
                if (index + offset === total - 1 && !segment.endsWith('\n')) {
                    lines.push(NO_NEWLINE);
                }
            }
        };
        let oldCursor = group.oldStart;
        for (const hunk of group.hunks) {
            const oldIndex = firstLineIndex(hunk.oldStart, hunk.oldLines);
            emit(' ', before, oldCursor, oldIndex - oldCursor, before.length);
            emit('-', before, oldIndex, hunk.oldLines, before.length);
            emit('+', after, firstLineIndex(hunk.newStart, hunk.newLines), hunk.newLines, after.length);
            oldCursor = oldIndex + hunk.oldLines;
        }
        emit(' ', before, oldCursor, group.oldEnd - oldCursor, before.length);
        return lines;
    }
}
