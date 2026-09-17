import { RangeHunk, REVIEW_LEVELS, ReviewLevel, reviewLevelRank } from '../types';
import { diffSegments, firstLineIndex, invertHunk, mapNewIndexToOld, spliceSegments } from './line-diff';
import { rangesOverlap } from './range-overlap';

export type LayerStack = readonly (readonly string[])[];

export type LayerMoveOutcome =
    | { kind: 'moved'; layers: string[][] }
    | { kind: 'conflict'; level: ReviewLevel };

export function levelHunks(layers: LayerStack, level: ReviewLevel): RangeHunk[] {
    const rank = reviewLevelRank(level);
    return diffSegments(layers[rank + 1], layers[rank]);
}

function oldRange(hunk: RangeHunk): { start: number; lines: number } {
    return { start: hunk.oldStart, lines: hunk.oldLines };
}

function newRange(hunk: RangeHunk): { start: number; lines: number } {
    return { start: hunk.newStart, lines: hunk.newLines };
}

function withOldIndex(hunk: RangeHunk, oldIndex: number): RangeHunk {
    return { ...hunk, oldStart: hunk.oldLines > 0 ? oldIndex + 1 : oldIndex };
}

function moveUp(layers: LayerStack, source: number, target: number, selected: readonly RangeHunk[]): LayerMoveOutcome {
    const result = layers.map(layer => [...layer]);
    for (let boundary = source + 1; boundary <= target; boundary++) {
        let mapped: RangeHunk[] = [...selected];
        if (boundary > source + 1) {
            const relation = diffSegments(layers[boundary], layers[source + 1]);
            if (relation.some(link => selected.some(hunk => rangesOverlap(newRange(link), oldRange(hunk))))) {
                return { kind: 'conflict', level: REVIEW_LEVELS[boundary - 1] };
            }
            mapped = selected.map(hunk => withOldIndex(
                hunk,
                mapNewIndexToOld(relation, firstLineIndex(hunk.oldStart, hunk.oldLines)),
            ));
        }
        result[boundary] = spliceSegments(layers[boundary], layers[source], mapped);
    }
    return { kind: 'moved', layers: result };
}

function moveDown(layers: LayerStack, source: number, target: number, selected: readonly RangeHunk[]): LayerMoveOutcome {
    const result = layers.map(layer => [...layer]);
    const reverted = selected.map(invertHunk);
    for (let boundary = source; boundary > target; boundary--) {
        let mapped: RangeHunk[] = reverted;
        if (boundary < source) {
            const relation = diffSegments(layers[source], layers[boundary]);
            if (relation.some(link => reverted.some(hunk => rangesOverlap(oldRange(link), oldRange(hunk))))) {
                return { kind: 'conflict', level: REVIEW_LEVELS[boundary] };
            }
            mapped = reverted.map(hunk => withOldIndex(
                hunk,
                mapNewIndexToOld(relation.map(invertHunk), firstLineIndex(hunk.oldStart, hunk.oldLines)),
            ));
        }
        result[boundary] = spliceSegments(layers[boundary], layers[source + 1], mapped);
    }
    return { kind: 'moved', layers: result };
}

export function moveLayerHunks(
    layers: LayerStack,
    sourceLevel: ReviewLevel,
    targetLevel: ReviewLevel,
    selected: readonly RangeHunk[],
): LayerMoveOutcome {
    const source = reviewLevelRank(sourceLevel);
    const target = reviewLevelRank(targetLevel);
    if (source === target || selected.length === 0) {
        return { kind: 'moved', layers: layers.map(layer => [...layer]) };
    }
    return target > source ? moveUp(layers, source, target, selected) : moveDown(layers, source, target, selected);
}
