import { FrontierRecord } from '../types';
import { blobReferenceLabel, legacyBlobReferences, textBlobReferenceEntries } from './record-codec';
import { RecordRoot } from './record-path-index';
import { ReviewBlobStore } from './review-blob-store';
import { RecordPair, ReviewStateStore } from './review-state-store';

const EARLIER_FORMAT_LABEL = 'an earlier format';

export type BlobRepairOutcome =
    | { kind: 'unreferenced' }
    | { kind: 'present' }
    | { kind: 'healed'; levels: string[] }
    | { kind: 'refused'; reason: string };

function referencingLevels(record: FrontierRecord, hash: string): string[] {
    return textBlobReferenceEntries(record).filter(reference => reference.hash === hash).map(reference => blobReferenceLabel(reference.slot));
}

function affectedRoots(pair: RecordPair, hash: string): { roots: RecordRoot[]; levels: string[] } {
    const roots: RecordRoot[] = [];
    const levels: string[] = [];
    const activeLevels = pair.active ? referencingLevels(pair.active, hash) : [];
    if (activeLevels.length > 0) {
        roots.push('files');
        levels.push(...activeLevels);
    }
    if (pair.legacy !== null && legacyBlobReferences(pair.legacy).includes(hash)) {
        roots.push('files');
        levels.push(EARLIER_FORMAT_LABEL);
    }
    const dormantLevels = pair.dormant ? referencingLevels(pair.dormant, hash) : [];
    if (dormantLevels.length > 0) {
        roots.push('dormant');
        levels.push(...dormantLevels);
    }
    return { roots: Array.from(new Set(roots)), levels: Array.from(new Set(levels)) };
}

export class RecordBlobRepair {
    constructor(
        private readonly store: ReviewStateStore,
        private readonly blobs: ReviewBlobStore,
    ) {}

    repair(repoPath: string, hash: string): Promise<BlobRepairOutcome> {
        return this.store.withStoreLock(async () => {
            const pair = await this.store.readPair(repoPath);
            const affected = affectedRoots(pair, hash);
            if (affected.roots.length === 0) {
                return { kind: 'unreferenced' };
            }
            if (await this.blobs.exists(hash)) {
                return { kind: 'present' };
            }
            try {
                await this.store.drop(repoPath, affected.roots);
            } catch (error) {
                return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) };
            }
            return { kind: 'healed', levels: affected.levels };
        });
    }
}
