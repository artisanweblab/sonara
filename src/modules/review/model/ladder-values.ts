import { LadderValues } from './level-ladder';
import { mergeKeepingOurs } from './three-way-merge';

export type Segments = readonly string[];

function isSameSegments(a: Segments, b: Segments): boolean {
    return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

export const SEGMENT_VALUES: LadderValues<Segments> = {
    isSame: isSameSegments,
    mergeOverIndex: mergeKeepingOurs,
    mergeKeepingOurs,
};

function keepOurs(base: string, ours: string, theirs: string): string {
    return ours !== base ? ours : theirs;
}

export const HASH_VALUES: LadderValues<string> = {
    isSame: (a, b) => a === b,
    mergeOverIndex: keepOurs,
    mergeKeepingOurs: keepOurs,
};
