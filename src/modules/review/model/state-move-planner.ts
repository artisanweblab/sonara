import { RangeHunk, ReviewLevel, reviewLevelRank } from '../types';
import { MISSING_MODE, REGULAR_MODE } from './file-state';
import { LayerStack, moveLayerHunks } from './layer-stack';
import { STAGED_RANK } from './level-ladder';

export const WHOLE_FILE_HUNK: RangeHunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 };

export interface StateLayers {
    content: string[][];
    modes: string[];
}

export type StateMoveOutcome =
    | { kind: 'moved'; layers: StateLayers }
    | { kind: 'conflict'; level: ReviewLevel }
    | { kind: 'dependent'; needs: 'content' | 'existence' };

export interface StateMoveRequest {
    source: ReviewLevel;
    target: ReviewLevel;
    hunks: readonly RangeHunk[];
    isModeIncluded: boolean;
    isCarryAllowed: boolean;
}

export type EmptyLayer = (layer: readonly string[]) => boolean;

export function normalizeDisplayModes(content: LayerStack, modes: readonly string[], headMode: string, isEmpty: EmptyLayer): string[] {
    const result = [...modes];
    for (let rank = STAGED_RANK - 1; rank >= 1; rank--) {
        if (result[rank] === MISSING_MODE && !isEmpty(content[rank])) {
            result[rank] = [result[rank + 1], headMode].find(mode => mode !== MISSING_MODE) ?? REGULAR_MODE;
        }
    }
    return result;
}

export function modeLayers(modes: readonly string[]): string[][] {
    return modes.map(mode => [`${mode}\n`]);
}

export function planStateMove(content: LayerStack, modes: readonly string[], request: StateMoveRequest, isEmpty: EmptyLayer): StateMoveOutcome {
    const source = reviewLevelRank(request.source);
    const target = reviewLevelRank(request.target);
    const contentOutcome = request.hunks.length > 0
        ? moveLayerHunks(content, request.source, request.target, request.hunks)
        : { kind: 'moved' as const, layers: content.map(layer => [...layer]) };
    if (contentOutcome.kind === 'conflict') {
        return contentOutcome;
    }
    let movedModes = [...modes];
    const isModeMoved = request.isModeIncluded && modes[source] !== modes[source + 1];
    if (isModeMoved) {
        const modeOutcome = moveLayerHunks(modeLayers(modes), request.source, request.target, [WHOLE_FILE_HUNK]);
        if (modeOutcome.kind === 'conflict') {
            return modeOutcome;
        }
        movedModes = modeOutcome.layers.map(layer => (layer[0] ?? '\n').slice(0, -1));
    }
    const isUpward = target > source;
    const carryMode = isUpward ? modes[source] : modes[source + 1];
    const isExistenceOnSource = isUpward ? modes[source + 1] === MISSING_MODE : modes[source] === MISSING_MODE;
    for (let rank = 1; rank <= STAGED_RANK; rank++) {
        if (movedModes[rank] !== MISSING_MODE || isEmpty(contentOutcome.layers[rank])) {
            continue;
        }
        if (isModeMoved) {
            return { kind: 'dependent', needs: 'content' };
        }
        if (!request.isCarryAllowed || carryMode === MISSING_MODE || !isExistenceOnSource) {
            return { kind: 'dependent', needs: 'existence' };
        }
        movedModes[rank] = carryMode;
    }
    return { kind: 'moved', layers: { content: contentOutcome.layers, modes: movedModes } };
}
