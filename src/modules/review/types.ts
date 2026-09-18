export const REVIEW_LEVELS = ['new', 'queued', 'read', 'verified', 'staged'] as const;

export type ReviewLevel = typeof REVIEW_LEVELS[number];

export const LEVEL_LABELS: Readonly<Record<ReviewLevel, string>> = {
    new: 'New',
    queued: 'Queued',
    read: 'Read',
    verified: 'Verified',
    staged: 'Staged Changes',
};

export const REVIEW_LEVELS_TOP_DOWN: readonly ReviewLevel[] = [...REVIEW_LEVELS].reverse();

export const STORED_REVIEW_LEVELS = ['queued', 'read', 'verified'] as const;

export type StoredReviewLevel = typeof STORED_REVIEW_LEVELS[number];

export function reviewLevelRank(level: ReviewLevel): number {
    return REVIEW_LEVELS.indexOf(level);
}

export interface Hunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    removedLines: string[];
    addedLines: string[];
    removedNoNewlineAtEof: boolean;
    addedNoNewlineAtEof: boolean;
}

export type FileChangeStatus = 'modified' | 'added' | 'deleted';

export interface FileChange {
    path: string;
    status: FileChangeStatus;
    isBinary: boolean;
    isSubmodule: boolean;
    isUnmerged: boolean;
    hunks: Hunk[];
}

export interface ReviewAtom {
    path: string;
    id: string;
}

export type ScannedFileKind = 'text' | 'opaque' | 'special';

export interface ScannedFile {
    path: string;
    kind: ScannedFileKind;
    stagedHunks: Hunk[];
    newHunks: Hunk[];
    hasStagedChange: boolean;
    hasNewChange: boolean;
    worktreeState: string;
    indexState: string;
    isInHead: boolean;
    isUnreadable: boolean;
}

export interface LineRange {
    start: number;
    lines: number;
}

export type FrontierKind = 'text' | 'opaque';

export interface StoredFrontierState {
    content?: string;
    mode?: string;
}

export type StoredFrontiers = Partial<Record<StoredReviewLevel, StoredFrontierState>>;

export interface FrontierRecord {
    version: 5;
    path: string;
    baseHead: string;
    kind: FrontierKind;
    frontiers: StoredFrontiers;
    indexBase?: StoredFrontierState;
}

export interface DormantRecord extends FrontierRecord {
    worktreeState: string;
    indexState: string;
    stashOid: string;
}

export interface FileGeneration {
    head: string;
    worktree: string;
    index: string;
    record: string;
}

export interface LevelChange {
    id: string;
    line: number;
    lineCount: number;
    label: string | null;
}

export interface LevelDocument {
    before: string;
    after: string;
    isBeforeMissing: boolean;
    isAfterMissing: boolean;
    changes: LevelChange[];
    generation: FileGeneration;
}

export interface ReviewAtomState {
    atom: ReviewAtom;
    level: ReviewLevel;
    status: string;
}

export interface ReviewFileState {
    path: string;
    scanned: ScannedFile;
    generation: FileGeneration;
    hasFrontiers: boolean;
    signature: string;
    atoms: ReviewAtomState[];
}

export interface RangeHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
}
