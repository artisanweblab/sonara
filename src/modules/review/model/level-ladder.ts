import { STORED_REVIEW_LEVELS, StoredReviewLevel, reviewLevelRank } from '../types';

export const STAGED_RANK = reviewLevelRank('staged');
export const HEAD_RANK = STAGED_RANK + 1;

const LEVELS_FROM_BASE: readonly StoredReviewLevel[] = [...STORED_REVIEW_LEVELS].sort((a, b) => reviewLevelRank(b) - reviewLevelRank(a));

export type LevelFrontiers<T> = Record<StoredReviewLevel | 'indexBase', T | null>;

export interface LadderValues<T> {
    isSame(a: T, b: T): boolean;
    mergeOverIndex(base: T, index: T, frontier: T): T;
    mergeKeepingOurs(base: T, ours: T, theirs: T): T;
}

export function emptyFrontiers<T>(): LevelFrontiers<T> {
    const frontiers = { indexBase: null } as LevelFrontiers<T>;
    STORED_REVIEW_LEVELS.forEach(level => {
        frontiers[level] = null;
    });
    return frontiers;
}

export function isEmptyFrontiers<T>(frontiers: LevelFrontiers<T>): boolean {
    return STORED_REVIEW_LEVELS.every(level => frontiers[level] === null);
}

function resolve<T>(head: T, frontiers: LevelFrontiers<T>): { base: T; states: Record<StoredReviewLevel, T> } {
    const base = frontiers.indexBase ?? head;
    const states = {} as Record<StoredReviewLevel, T>;
    let below = base;
    for (const level of LEVELS_FROM_BASE) {
        below = frontiers[level] ?? below;
        states[level] = below;
    }
    return { base, states };
}

function normalize<T>(head: T, base: T, states: Record<StoredReviewLevel, T>, values: LadderValues<T>): LevelFrontiers<T> {
    const frontiers = { indexBase: values.isSame(base, head) ? null : base } as LevelFrontiers<T>;
    let below = base;
    for (const level of LEVELS_FROM_BASE) {
        frontiers[level] = values.isSame(states[level], below) ? null : states[level];
        below = states[level];
    }
    return frontiers;
}

export function buildStack<T>(head: T, index: T, worktree: T, frontiers: LevelFrontiers<T>, isFullyStaged: boolean, values: LadderValues<T>): T[] {
    const layers: T[] = new Array<T>(HEAD_RANK + 1);
    layers[0] = worktree;
    layers[STAGED_RANK] = index;
    layers[HEAD_RANK] = head;
    const { base, states } = resolve(head, frontiers);
    for (const level of STORED_REVIEW_LEVELS) {
        layers[reviewLevelRank(level)] = isFullyStaged
            ? index
            : values.isSame(index, base) ? states[level] : values.mergeOverIndex(base, index, states[level]);
    }
    return layers;
}

export function frontiersFromLayers<T>(head: T, layers: readonly T[], values: LadderValues<T>): LevelFrontiers<T> {
    const states = {} as Record<StoredReviewLevel, T>;
    STORED_REVIEW_LEVELS.forEach(level => {
        states[level] = layers[reviewLevelRank(level)];
    });
    return normalize(head, layers[STAGED_RANK], states, values);
}

export function rebaseFrontiers<T>(oldHead: T, newHead: T, frontiers: LevelFrontiers<T>, values: LadderValues<T>): LevelFrontiers<T> {
    const old = resolve(oldHead, frontiers);
    const base = values.mergeKeepingOurs(oldHead, newHead, old.base);
    const states = {} as Record<StoredReviewLevel, T>;
    let oldBelow = old.base;
    let newBelow = base;
    for (const level of LEVELS_FROM_BASE) {
        states[level] = values.mergeKeepingOurs(oldBelow, newBelow, old.states[level]);
        oldBelow = old.states[level];
        newBelow = states[level];
    }
    return normalize(newHead, base, states, values);
}
