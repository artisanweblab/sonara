import { GitRepositoryState } from '../git/git-repository-state';
import { IndexGit } from '../git/index-git';
import { IndexWrite, IndexWriteResult } from '../git/index-target';
import { IndexTransaction } from '../git/index-transaction';
import { ParsedIndexEntry } from '../git/index-entries';
import { SnapshotBatchLoader } from '../git/snapshot-batch-loader';
import { ReviewLogger } from '../logging/review-logger';
import { recordId } from '../model/file-generation';
import { mapLimit } from '../model/map-limit';
import { JournalDocument, JournalIndex, MoveJournal } from '../store/move-journal';
import { ProcessIdentity } from '../store/process-identity';
import { RecordPair, ReviewStateStore } from '../store/review-state-store';
import { ReviewBlobStore } from '../store/review-blob-store';
import { FileGeneration, FrontierRecord } from '../types';
import { FrontierRepository } from './frontier-repository';
import { MoveOutcome, flaggedMessage, refused, stale } from './move-outcome';
import { MoveRecovery } from './move-recovery';

const WRITE_CONCURRENCY = 32;

export interface CommitEntry {
    repoPath: string;
    generation: FileGeneration;
    expectedRecordId: string | null;
    isRecordChanged: boolean;
    record: FrontierRecord | null;
    blobHashes: readonly string[];
    indexWrite: { mode: string; objectId: string | null } | null;
}

export interface CommitSummary {
    outcomes: Map<CommitEntry, MoveOutcome>;
    recordsWritten: number;
    indexEntriesWritten: number;
    lockWaitMs: number;
}

function errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).split('\n')[0];
}

export class MoveCommitter {
    constructor(
        private readonly repository: FrontierRepository,
        private readonly store: ReviewStateStore,
        private readonly blobs: ReviewBlobStore,
        private readonly journal: MoveJournal,
        private readonly recovery: MoveRecovery,
        private readonly snapshots: SnapshotBatchLoader,
        private readonly gitState: GitRepositoryState,
        private readonly indexGit: IndexGit,
        private readonly projectPrefix: string,
        private readonly logger: ReviewLogger,
    ) {}

    async commit(entries: readonly CommitEntry[]): Promise<CommitSummary> {
        const summary: CommitSummary = { outcomes: new Map(), recordsWritten: 0, indexEntriesWritten: 0, lockWaitMs: 0 };
        if (entries.length === 0) {
            return summary;
        }
        const identity = await ProcessIdentity.ofCurrentProcess();
        const requestedAt = Date.now();
        try {
            await this.repository.withStoreLock(async () => {
                summary.lockWaitMs = Date.now() - requestedAt;
                await this.recovery.recoverLocked();
                await this.commitLocked(entries, identity, summary);
            });
        } catch (error) {
            this.logger.error(`Move commit of ${entries.length} files failed, nothing was changed`, error);
            for (const entry of entries) {
                if (summary.outcomes.get(entry)?.kind === 'moved' || !summary.outcomes.has(entry)) {
                    summary.outcomes.set(entry, { kind: 'failed', message: errorMessage(error) });
                }
            }
            summary.recordsWritten = 0;
            summary.indexEntriesWritten = 0;
        }
        return summary;
    }

    private async commitLocked(entries: readonly CommitEntry[], identity: string | null, summary: CommitSummary): Promise<void> {
        const outcomes = summary.outcomes;
        const head = await this.gitState.currentHead();
        const pairs = await this.store.readPairs(entries.map(entry => entry.repoPath));
        const missingBlobs = await this.missingBlobs(entries);
        let candidates = entries.filter(entry => {
            const rejection = this.recordRejection(entry, head, pairs.get(entry.repoPath) as RecordPair, missingBlobs);
            if (rejection) {
                outcomes.set(entry, rejection);
            }
            return rejection === null;
        });
        if (candidates.length === 0) {
            return;
        }
        const writes = candidates.filter(entry => entry.indexWrite !== null);
        const transaction = writes.length > 0 ? await IndexTransaction.open(this.indexGit, await this.gitState.indexFile()) : null;
        try {
            const paths = candidates.map(entry => entry.repoPath);
            const indexEntries = transaction ? await transaction.entries(paths, this.projectPrefix) : await this.snapshots.indexEntries(paths);
            candidates = candidates.filter(entry => {
                const isCurrent = (indexEntries.get(entry.repoPath) as ParsedIndexEntry).state === entry.generation.index;
                if (!isCurrent) {
                    outcomes.set(entry, stale('the staged version changed'));
                }
                return isCurrent;
            });
            const results = transaction
                ? await transaction.apply(candidates.filter(entry => entry.indexWrite).map(entry => this.indexWrite(entry)), indexEntries)
                : new Map<string, IndexWriteResult>();
            candidates = candidates.filter(entry => {
                const result = results.get(entry.repoPath);
                if (result?.kind === 'stale') {
                    outcomes.set(entry, stale('the staged version changed'));
                } else if (result?.kind === 'flagged') {
                    outcomes.set(entry, refused(flaggedMessage(entry.repoPath)));
                }
                return result === undefined || result.kind === 'written';
            });
            const recordEntries = candidates.filter(entry => entry.isRecordChanged);
            const index: JournalIndex | null = transaction?.hasChanges()
                ? {
                    indexPath: transaction.indexPath,
                    lockPath: transaction.lockPath,
                    lockDev: transaction.lockIdentity.dev,
                    lockIno: transaction.lockIdentity.ino,
                    lockBirthMs: transaction.lockIdentity.birthMs,
                    finalSha256: transaction.finalSha(),
                    states: Array.from(results).flatMap(([path, result]) => result.kind === 'written' ? [{ path, after: result.state }] : []),
                }
                : null;
            if (recordEntries.length > 0 || index) {
                const document = this.journal.create(
                    recordEntries.map(entry => ({ path: entry.repoPath, previous: pairs.get(entry.repoPath)?.active ?? null, next: entry.record })),
                    identity,
                    index,
                );
                await this.apply(document, transaction);
                summary.recordsWritten = recordEntries.length;
                summary.indexEntriesWritten = index?.states.length ?? 0;
            }
            for (const entry of candidates) {
                const result = results.get(entry.repoPath);
                outcomes.set(entry, {
                    kind: 'moved',
                    generation: { ...entry.generation, index: result?.kind === 'written' ? result.state : entry.generation.index },
                });
            }
        } finally {
            await transaction?.release();
        }
    }

    private recordRejection(entry: CommitEntry, head: string, pair: RecordPair, missingBlobs: ReadonlySet<string>): MoveOutcome | null {
        if (entry.generation.head !== head) {
            return stale('HEAD changed');
        }
        if (pair.isNewerVersion) {
            return refused(`${entry.repoPath}: its review levels were written by a newer version of Sonara. Update or reload this window first.`);
        }
        if (entry.expectedRecordId !== null && (pair.legacy !== null || recordId(pair.active) !== entry.expectedRecordId)) {
            return stale('the review levels were changed in another window');
        }
        if (entry.blobHashes.some(hash => missingBlobs.has(hash))) {
            return stale('an accepted version was removed while the move was prepared');
        }
        return null;
    }

    private async missingBlobs(entries: readonly CommitEntry[]): Promise<Set<string>> {
        const hashes = Array.from(new Set(entries.flatMap(entry => entry.blobHashes)));
        const exists = await mapLimit(hashes, WRITE_CONCURRENCY, hash => this.blobs.exists(hash));
        return new Set(hashes.filter((_hash, position) => !exists[position]));
    }

    private indexWrite(entry: CommitEntry): IndexWrite {
        const write = entry.indexWrite as { mode: string; objectId: string | null };
        return { repoPath: entry.repoPath, expectedState: entry.generation.index, mode: write.mode, objectId: write.objectId };
    }

    private async apply(document: JournalDocument, transaction: IndexTransaction | null): Promise<void> {
        const file = await this.journal.write(document);
        try {
            await mapLimit(document.entries, WRITE_CONCURRENCY, entry => this.store.writeActive(entry.path, entry.next));
            if (document.index) {
                await transaction?.commit();
            }
        } catch (error) {
            this.logger.error(`Move commit failed while writing, restoring ${document.entries.length} review records`, error);
            for (const entry of document.entries) {
                await this.store.writeActive(entry.path, entry.previous);
            }
            await this.journal.remove(file);
            throw error;
        }
        await this.journal.remove(file);
    }
}
