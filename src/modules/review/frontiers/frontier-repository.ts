import { Segments } from '../model/ladder-values';
import { LevelFrontiers } from '../model/level-ladder';
import { textBlobReferences } from '../store/record-codec';
import { RecordRoot } from '../store/record-path-index';
import { ReviewBlobStore } from '../store/review-blob-store';
import { RecordChange, RecordPair, ReviewStateStore } from '../store/review-state-store';
import { FrontierRecord } from '../types';
import {
    EncodedRecord,
    FileFrontiers,
    encodeOpaque,
    encodeText,
    opaqueFrontiers,
    textFrontiersFromBlobs,
} from './frontier-encoding';

export class FrontierRepository {
    private inFlight = 0;

    constructor(
        private readonly store: ReviewStateStore,
        private readonly blobs: ReviewBlobStore,
    ) {}

    read(repoPath: string): Promise<FrontierRecord | null> {
        return this.store.read(repoPath);
    }

    readPair(repoPath: string): Promise<RecordPair> {
        return this.store.readPair(repoPath);
    }

    readPairs(repoPaths: readonly string[]): Promise<Map<string, RecordPair>> {
        return this.store.readPairs(repoPaths);
    }

    knownPaths(root: RecordRoot): string[] {
        return this.store.knownPaths(root);
    }

    recordModifiedAt(repoPath: string): Promise<number | null> {
        return this.store.recordModifiedAt(repoPath);
    }

    async transact(repoPath: string, mutation: (pair: RecordPair) => Promise<RecordChange> | RecordChange): Promise<RecordPair> {
        return this.tracked(() => this.store.transact(repoPath, mutation));
    }

    withStoreLock<T>(task: () => Promise<T>): Promise<T> {
        return this.tracked(() => this.store.withStoreLock(task));
    }

    async tracked<T>(task: () => Promise<T>): Promise<T> {
        this.inFlight++;
        try {
            return await task();
        } finally {
            this.inFlight--;
        }
    }

    isBusy(): boolean {
        return this.inFlight > 0;
    }

    async textFrontiers(record: FrontierRecord | null): Promise<FileFrontiers<LevelFrontiers<Segments>>> {
        const blobs = new Map<string, Buffer>();
        if (record?.kind === 'text') {
            for (const hash of textBlobReferences(record)) {
                blobs.set(hash, await this.blobs.read(hash));
            }
        }
        return textFrontiersFromBlobs(record, blobs);
    }

    opaqueFrontiers(record: FrontierRecord | null): FileFrontiers<LevelFrontiers<string>> {
        return opaqueFrontiers(record);
    }

    encodeText(repoPath: string, head: string, frontiers: FileFrontiers<LevelFrontiers<Segments>>): EncodedRecord {
        return encodeText(repoPath, head, frontiers);
    }

    encodeOpaque(repoPath: string, head: string, frontiers: FileFrontiers<LevelFrontiers<string>>): EncodedRecord {
        return encodeOpaque(repoPath, head, frontiers);
    }
}
