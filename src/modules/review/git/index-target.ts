export type IndexTarget =
    | { kind: 'remove' }
    | { kind: 'blob'; mode: string; content: Buffer }
    | { kind: 'object'; mode: string; objectId: string };

export interface IndexWrite {
    repoPath: string;
    expectedState: string;
    mode: string;
    objectId: string | null;
}

export type IndexWriteResult =
    | { kind: 'written'; state: string }
    | { kind: 'stale'; actual: string }
    | { kind: 'flagged' };
