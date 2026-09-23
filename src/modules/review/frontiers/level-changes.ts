import { NO_RECORD } from '../model/file-generation';
import { MISSING_MODE, REGULAR_MODE, UNMERGED_STATE, describeModeChange, modeOfState } from '../model/file-state';
import { hunkContext, hunkKey } from '../model/hunk-key';
import { levelHunks } from '../model/layer-stack';
import { toHunk } from '../model/line-diff';
import { FileGeneration, REVIEW_LEVELS, RangeHunk, ReviewAtomState, ReviewLevel, ScannedFile, reviewLevelRank } from '../types';
import { FileStack, layerHash } from './file-stack';

export const FILE_CHANGE_KEY = 'file';

export interface FileEvaluation {
    atoms: ReviewAtomState[];
    generation: FileGeneration;
}

export interface StateLevelChange {
    id: string;
    range: RangeHunk | null;
    label: string | null;
    isExistence: boolean;
    isMode: boolean;
    state: ReviewAtomState;
}

function stripLineEnds(segments: readonly string[]): string[] {
    return segments.map(segment => segment.endsWith('\n') ? segment.slice(0, -1) : segment);
}

export function fileChangeId(): string {
    return `${FILE_CHANGE_KEY}#0`;
}

function fileAtom(path: string, level: ReviewLevel, status: string): ReviewAtomState {
    return { level, status, atom: { path, id: fileChangeId() } };
}

function statusOf(below: string, above: string, isUnmerged: boolean): string {
    if (isUnmerged) {
        return 'U';
    }
    if (below === MISSING_MODE) {
        return 'A';
    }
    return above === MISSING_MODE ? 'D' : 'M';
}

export function scanGeneration(file: ScannedFile, head: string): FileGeneration {
    return { head, worktree: file.worktreeState, index: file.indexState, record: NO_RECORD };
}

export function levelChanges(path: string, stack: FileStack, level: ReviewLevel): StateLevelChange[] {
    const rank = reviewLevelRank(level);
    const below = stack.modes[rank + 1];
    const above = stack.modes[rank];
    const modeLabel = below !== above ? describeModeChange(below, above) : null;
    const isExistence = below === MISSING_MODE || above === MISSING_MODE;
    const status = statusOf(below, above, false);
    if (stack.kind === 'opaque') {
        const contentChanged = layerHash(stack.content[rank + 1]) !== layerHash(stack.content[rank]);
        if (!contentChanged && !modeLabel) {
            return [];
        }
        const label = contentChanged && modeLabel && below !== MISSING_MODE && above !== MISSING_MODE
            ? `content changed, ${modeLabel}`
            : modeLabel ?? 'content changed';
        return [{ id: fileChangeId(), range: null, label, isExistence, isMode: false, state: fileAtom(path, level, status) }];
    }
    const before = stack.content[rank + 1];
    const after = stack.content[rank];
    const afterLines = stripLineEnds(after);
    const occurrences = new Map<string, number>();
    const changes: StateLevelChange[] = levelHunks(stack.content, level).map(range => {
        const hunk = toHunk(before, after, range);
        const key = hunkKey(path, hunk, hunkContext(hunk, afterLines));
        const ordinal = occurrences.get(key) ?? 0;
        occurrences.set(key, ordinal + 1);
        const id = `${key}#${ordinal}`;
        return { id, range, label: null, isExistence: false, isMode: false, state: { level, status, atom: { path, id } } };
    });
    if (modeLabel) {
        changes.push({ id: fileChangeId(), range: null, label: modeLabel, isExistence, isMode: !isExistence, state: fileAtom(path, level, status) });
    }
    return changes;
}

export function stackAtoms(path: string, stack: FileStack): ReviewAtomState[] {
    return REVIEW_LEVELS.flatMap(level => levelChanges(path, stack, level).map(change => change.state));
}

export function gitAtoms(file: ScannedFile): ReviewAtomState[] {
    const atoms: ReviewAtomState[] = [];
    const isUnmerged = file.indexState === UNMERGED_STATE;
    const indexMode = modeOfState(file.indexState) ?? MISSING_MODE;
    const worktreeMode = modeOfState(file.worktreeState) ?? MISSING_MODE;
    const stagedStatus = statusOf(file.isInHead ? REGULAR_MODE : MISSING_MODE, indexMode, isUnmerged);
    const newStatus = statusOf(indexMode, worktreeMode, isUnmerged);
    const add = (level: ReviewLevel, hasChange: boolean, hunks: ScannedFile['stagedHunks']): void => {
        const status = level === 'staged' ? stagedStatus : newStatus;
        hunks.forEach((_hunk, index) => atoms.push({
            level,
            status,
            atom: { path: file.path, id: `git:${level}:${index}` },
        }));
        if (hasChange && hunks.length === 0) {
            atoms.push(fileAtom(file.path, level, status));
        }
    };
    add('staged', file.hasStagedChange && file.indexState !== UNMERGED_STATE, file.kind === 'text' ? file.stagedHunks : []);
    add('new', file.hasNewChange, file.kind === 'text' ? file.newHunks : []);
    return atoms;
}
