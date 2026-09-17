import { ComputePool } from './compute/compute-pool';
import { BulkEvaluator } from './frontiers/bulk-evaluator';
import { FileStackBuilder } from './frontiers/file-stack-builder';
import { FrontierEvaluator } from './frontiers/frontier-evaluator';
import { FrontierMover } from './frontiers/frontier-mover';
import { FrontierRepository } from './frontiers/frontier-repository';
import { FrontierSynchronizer } from './frontiers/frontier-synchronizer';
import { MoveCommitter } from './frontiers/move-committer';
import { MoveRecovery } from './frontiers/move-recovery';
import { SpecialFileMover } from './frontiers/special-file-mover';
import { BlobHasher } from './git/blob-hasher';
import { ChangeScanner } from './git/change-scanner';
import { ContentLoader } from './git/content-loader';
import { ConversionProbe } from './git/conversion-probe';
import { GitReader } from './git/git-reader';
import { GitRepositoryState } from './git/git-repository-state';
import { IndexGit } from './git/index-git';
import { ObjectBatchReader } from './git/object-batch-reader';
import { SnapshotBatchLoader } from './git/snapshot-batch-loader';
import { StashReader } from './git/stash-reader';
import { ReviewLogger } from './logging/review-logger';
import { LegacyRecordMigrator } from './migration/legacy-record-migrator';
import { ReviewLevelMover } from './review-level-mover';
import { ReviewScope } from './review-scope';
import { MoveJournal } from './store/move-journal';
import { ReviewBlobStore } from './store/review-blob-store';
import { ReviewStateStore } from './store/review-state-store';
import { ReviewFileState } from './types';

export interface ReviewEngine {
    scope: ReviewScope;
    gitState: GitRepositoryState;
    loader: ContentLoader;
    scanner: ChangeScanner;
    evaluator: FrontierEvaluator;
    bulkEvaluator: BulkEvaluator;
    synchronizer: FrontierSynchronizer;
    mover: ReviewLevelMover;
    repository: FrontierRepository;
    recovery: MoveRecovery;
    journal: MoveJournal;
    stashReader: StashReader;
    pool: ComputePool;
}

export interface ReviewEngineOptions {
    folderPath: string;
    repoRoot: string;
    reviewRoot: string;
    gitPath: string;
    store: ReviewStateStore;
    blobs: ReviewBlobStore;
    logger: ReviewLogger;
    getFile: (repoPath: string) => ReviewFileState | undefined;
}

export function createReviewEngine(options: ReviewEngineOptions): ReviewEngine {
    const { repoRoot, gitPath, logger, store, blobs } = options;
    const scope = new ReviewScope(options.folderPath, repoRoot);
    const reader = new GitReader(repoRoot, logger, gitPath);
    const gitState = new GitRepositoryState(reader, repoRoot);
    const loader = new ContentLoader(reader, gitState, repoRoot);
    const repository = new FrontierRepository(store, blobs);
    const probe = new ConversionProbe(reader);
    const snapshots = new SnapshotBatchLoader(reader, new ObjectBatchReader(reader, probe), loader, scope.projectPrefix);
    const pool = new ComputePool(logger);
    const indexGit = new IndexGit(repoRoot, gitPath, logger);
    const journal = new MoveJournal(options.reviewRoot);
    const recovery = new MoveRecovery(journal, store, reader, logger);
    const committer = new MoveCommitter(repository, store, blobs, journal, recovery, snapshots, gitState, indexGit, scope.projectPrefix, logger);
    const stashReader = new StashReader(reader, loader, gitState);
    const frontierMover = new FrontierMover(
        snapshots,
        new SpecialFileMover(reader, loader, logger),
        repository,
        blobs,
        new BlobHasher(indexGit, probe),
        pool,
        committer,
        gitState,
        logger,
    );
    return {
        scope,
        gitState,
        loader,
        scanner: new ChangeScanner(reader, loader, gitState, scope.reviewRepoPath),
        evaluator: new FrontierEvaluator(new FileStackBuilder(loader, blobs)),
        bulkEvaluator: new BulkEvaluator(snapshots, blobs, pool),
        synchronizer: new FrontierSynchronizer(loader, gitState, repository, new LegacyRecordMigrator(reader, loader, repository, blobs), stashReader, logger),
        mover: new ReviewLevelMover(frontierMover, logger, options.getFile),
        repository,
        recovery,
        journal,
        stashReader,
        pool,
    };
}
