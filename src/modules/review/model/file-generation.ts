import { createHash } from 'crypto';
import { FileGeneration, FrontierRecord, STORED_REVIEW_LEVELS } from '../types';

export const NO_RECORD = 'none';

export function recordId(record: FrontierRecord | null): string {
    if (!record) {
        return NO_RECORD;
    }
    const canonical = {
        baseHead: record.baseHead,
        kind: record.kind,
        frontiers: STORED_REVIEW_LEVELS.map(level => [level, record.frontiers[level]?.content ?? null, record.frontiers[level]?.mode ?? null]),
        indexBase: [record.indexBase?.content ?? null, record.indexBase?.mode ?? null],
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function staleReason(expected: FileGeneration, actual: FileGeneration): string | null {
    if (expected.head !== actual.head) {
        return 'HEAD changed';
    }
    if (expected.worktree !== actual.worktree) {
        return 'the working file changed';
    }
    if (expected.index !== actual.index) {
        return 'the staged version changed';
    }
    if (expected.record !== actual.record) {
        return 'the review levels were changed in another window';
    }
    return null;
}

export function describeGeneration(generation: FileGeneration): string {
    return `head ${generation.head.slice(0, 12)}, worktree ${generation.worktree.slice(0, 20)}, index ${generation.index.slice(0, 20)}, record ${generation.record.slice(0, 12)}`;
}
