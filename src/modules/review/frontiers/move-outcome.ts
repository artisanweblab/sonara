import type { IndexTarget } from '../git/index-target';
import { FileGeneration, LEVEL_LABELS, ReviewLevel, ScannedFile } from '../types';

export interface MoveCommand {
    file: ScannedFile;
    generation: FileGeneration;
    source: ReviewLevel;
    target: ReviewLevel;
    changeIds: ReadonlySet<string> | null;
}

export type MoveOutcome =
    | { kind: 'moved'; generation: FileGeneration }
    | { kind: 'refused'; message: string }
    | { kind: 'stale'; reason: string }
    | { kind: 'failed'; message: string };

export interface PreparedMove {
    outcome: MoveOutcome | null;
    indexTarget: IndexTarget | null;
    generation: FileGeneration;
}

export function preparedOutcome(outcome: MoveOutcome, generation: FileGeneration): PreparedMove {
    return { outcome, indexTarget: null, generation };
}

export function flaggedMessage(repoPath: string): string {
    return `${repoPath}: the staged entry has skip-worktree or assume-unchanged set. Sonara Review does not change such entries; clear the flag with git update-index first.`;
}

export function unresolvedMessage(repoPath: string): string {
    return `${repoPath}: the merge conflict is not resolved. Resolve it and stage the result instead of unstaging.`;
}

export function refused(message: string): MoveOutcome {
    return { kind: 'refused', message };
}

export function stale(reason: string): MoveOutcome {
    return { kind: 'stale', reason };
}

export function noChangeMessage(repoPath: string, targetLevel: ReviewLevel): string {
    return `${repoPath}: nothing could be placed on the ${LEVEL_LABELS[targetLevel]} level. These changes sit where the staged version and the accepted versions disagree. Stage the file (Staged Changes) or unstage it first.`;
}

export function conflictMessage(repoPath: string, level: ReviewLevel): string {
    return `${repoPath}: these changes touch the same lines as changes on the ${LEVEL_LABELS[level]} level. Move those first.`;
}

export function dependentMessage(repoPath: string, needs: 'content' | 'existence'): string {
    return needs === 'content'
        ? `${repoPath}: creating or deleting the file depends on line changes that are on another level. Move those line changes first.`
        : `${repoPath}: these line changes depend on the file being created or deleted on another level. Move that change first.`;
}

export function waitingMessage(repoPath: string): string {
    return `${repoPath}: review levels are waiting for the current git operation to finish. Try again afterwards.`;
}
