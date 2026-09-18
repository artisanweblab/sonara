import * as path from 'path';
import * as vscode from 'vscode';
import { reviewDir } from '../../shared/project-layout';
import { GitCommandError } from './git/git-command-error';
import { GitReader } from './git/git-reader';
import { RepositoryChange, RepositoryWatcher } from './git/repository-watcher';
import { ReviewLogger } from './logging/review-logger';
import { describeGeneration } from './model/file-generation';
import { ProgressRunner } from './progress-runner';
import { ReviewEngine, createReviewEngine } from './review-engine';
import { LevelMoveReport, LevelMoveRequest, LevelSelection, requestsFromSelections } from './review-level-mover';
import { ReviewPasses } from './review-passes';
import { ReviewStorageNotices } from './review-storage-notices';
import { BlobGarbageCollector } from './store/blob-garbage-collector';
import { RecordBlobRepair } from './store/record-blob-repair';
import { ReviewBlobStore } from './store/review-blob-store';
import { ReviewStateStore } from './store/review-state-store';
import { ReviewStorageError } from './store/review-storage-error';
import { StorageHealth } from './store/storage-health';
import { FileGeneration, FrontierRecord, LEVEL_LABELS, LevelDocument, ReviewAtomState, ReviewFileState, ReviewLevel } from './types';

const NOTIFICATION_PROGRESS_THRESHOLD = 50;

const windowProgress: ProgressRunner = async <T>(title: string, task: () => Promise<T>): Promise<T> =>
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, task);

export interface LevelChangeReference {
    repoPath: string;
    level: ReviewLevel;
    changeId: string;
    generation: FileGeneration;
}

export interface ChangeMoveResult {
    report: LevelMoveReport;
    remainingOnLevel: number;
}

export function inactiveMessage(service: ReviewService | undefined): string {
    return `Sonara Review is not active for this project: ${service?.getIdleReason() ?? 'no project folder is open'}.`;
}

export class ReviewService implements vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.emitter.event;

    private readonly health = new StorageHealth();
    private readonly store: ReviewStateStore;
    private readonly blobs: ReviewBlobStore;
    private readonly notices: ReviewStorageNotices;
    private readonly watcher: RepositoryWatcher;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly pendingPaths = new Set<string>();
    private readonly pendingRecordFiles = new Set<string>();
    private isFullPending = false;
    private isStashPending = false;
    private isDraining = false;
    private runningTasks = 0;
    private exclusive: Promise<void> = Promise.resolve();
    private engine: ReviewEngine | undefined;
    private passes: ReviewPasses | undefined;
    private collector: BlobGarbageCollector | undefined;
    private isStarted = false;
    private idleReason = 'the review is still starting';
    private isDisposed = false;

    constructor(
        private readonly folder: vscode.WorkspaceFolder,
        private readonly logger: ReviewLogger,
    ) {
        this.blobs = new ReviewBlobStore(reviewDir(folder));
        this.store = new ReviewStateStore(reviewDir(folder), this.health, this.blobs);
        this.notices = new ReviewStorageNotices(this.store, new RecordBlobRepair(this.store, this.blobs), this.health, logger, repoPath => this.queuePaths([repoPath]));
        this.watcher = new RepositoryWatcher(folder, reviewDir(folder), logger);
        this.disposables.push(this.watcher);
    }

    async start(): Promise<void> {
        const started = await this.watcher.start();
        if (this.isDisposed) {
            return;
        }
        if ('reason' in started) {
            this.becomeIdle(started.reason);
            void vscode.window.showWarningMessage(`Sonara Review needs the built-in Git extension: ${started.reason}. Enable it, then reload the window.`);
            return;
        }
        let repoRoot: string;
        try {
            const [topLevel] = await new GitReader(this.folder.uri.fsPath, this.logger, started.gitPath).lines(['rev-parse', '--show-toplevel']);
            if (!topLevel) {
                throw new Error('git returned an empty repository path');
            }
            repoRoot = path.resolve(topLevel);
        } catch (error) {
            this.becomeIdle(this.repositoryProblem(error));
            return;
        }
        if (this.isDisposed) {
            return;
        }
        this.logger.info(`Review started for ${this.folder.uri.fsPath}, repository root ${repoRoot}`);
        const engine = createReviewEngine({
            folderPath: this.folder.uri.fsPath,
            repoRoot,
            reviewRoot: reviewDir(this.folder),
            gitPath: started.gitPath,
            store: this.store,
            blobs: this.blobs,
            logger: this.logger,
            getFile: repoPath => this.passes?.getFile(repoPath),
        });
        this.engine = engine;
        this.passes = new ReviewPasses(engine, this.store, this.logger, () => this.isDisposed, (repoPath, error) => void this.notices.onEvaluationError(repoPath, error), windowProgress);
        this.collector = new BlobGarbageCollector(this.blobs, this.store, engine.journal, this.health, this.logger, () => this.runningTasks > 0 || engine.repository.isBusy());
        this.disposables.push(new vscode.Disposable(() => this.collector?.dispose()), new vscode.Disposable(() => engine.pool.dispose()));
        await this.recover(engine);
        this.watcher.watchGitOperations(await engine.gitState.resolveGitDir(), await engine.gitState.resolveCommonDir(), await engine.gitState.indexFile());
        this.isStarted = true;
        this.idleReason = '';
        this.disposables.push(this.watcher.onDidChange(change => this.onRepositoryChange(change)));
        this.isFullPending = true;
        await this.drain();
        this.collector.schedule();
    }

    isActive(): boolean {
        return this.isStarted;
    }

    getIdleReason(): string {
        return this.idleReason;
    }

    getRepositoryRoot(): string {
        return this.engine?.scope.repoRoot ?? '';
    }

    getProjectPrefix(): string {
        return this.engine?.scope.projectPrefix ?? '';
    }

    absolutePath(repoPath: string): string {
        return this.engine ? this.engine.scope.absolutePath(repoPath) : repoPath;
    }

    repoPathForFile(fsPath: string): string | null {
        return this.engine?.scope.toRepoPath(fsPath) ?? null;
    }

    getFile(repoPath: string): ReviewFileState | undefined {
        return this.passes?.getFile(repoPath);
    }

    getFiles(): ReviewFileState[] {
        return this.passes?.getFiles() ?? [];
    }

    getAtomsByLevel(): Map<ReviewLevel, ReviewAtomState[]> {
        return this.passes?.getAtomsByLevel() ?? new Map();
    }

    async levelDocument(repoPath: string, level: ReviewLevel): Promise<LevelDocument | null> {
        const file = this.passes?.getFile(repoPath);
        const engine = this.engine;
        if (!file || !engine || !this.passes) {
            return null;
        }
        try {
            const record = await this.passes.usableRecord(repoPath);
            return await this.buildDocument(repoPath, file.scanned, record, level, file.generation);
        } catch (error) {
            if (error instanceof ReviewStorageError && error.kind === 'blob-missing') {
                await this.notices.onEvaluationError(repoPath, error);
                this.logger.info(`Level diff for ${repoPath} ${level} is built without the stored levels: ${error.message}`);
                return await this.buildDocument(repoPath, file.scanned, null, level, file.generation);
            }
            this.logger.error(`Level diff for ${repoPath} ${level} failed`, error);
            throw error;
        }
    }

    private async buildDocument(
        repoPath: string,
        scanned: ReviewFileState['scanned'],
        record: FrontierRecord | null,
        level: ReviewLevel,
        generation: FileGeneration,
    ): Promise<LevelDocument | null> {
        const engine = this.engine;
        if (!engine || !this.passes) {
            return null;
        }
        const document = await engine.evaluator.document(scanned, this.passes.getHead(), record, level);
        this.logger.info(`Level diff built: ${repoPath} ${level}, ${document.changes.length} changes, frontiers ${record ? Object.keys(record.frontiers).join(',') : 'none'}, ${describeGeneration(document.generation)}`);
        if (document.generation.worktree !== generation.worktree || document.generation.index !== generation.index || document.generation.record !== generation.record) {
            this.logger.info(`Level diff: ${repoPath} changed since the last scan, rescan queued`);
            this.queuePaths([repoPath]);
        }
        return document;
    }

    async firstWorkingLine(repoPath: string, level: ReviewLevel): Promise<number> {
        const file = this.passes?.getFile(repoPath);
        if (!file || !this.engine || !this.passes) {
            return 0;
        }
        return this.engine.evaluator.firstWorkingLine(file.scanned, this.passes.getHead(), await this.passes.usableRecord(repoPath), level);
    }

    moveToLevel(selections: readonly LevelSelection[], target: ReviewLevel): Promise<LevelMoveReport> {
        return this.runMove(requestsFromSelections(selections), target);
    }

    async moveChange(change: LevelChangeReference, target: ReviewLevel): Promise<ChangeMoveResult> {
        const report = await this.runMove([{
            repoPath: change.repoPath,
            sourceLevel: change.level,
            changeIds: new Set([change.changeId]),
            generation: change.generation,
        }], target);
        const remainingOnLevel = this.getFile(change.repoPath)?.atoms.filter(state => state.level === change.level).length ?? 0;
        return { report, remainingOnLevel };
    }

    requestFullScan(): void {
        if (!this.isStarted) {
            return;
        }
        this.isFullPending = true;
        void this.drain();
    }

    private becomeIdle(reason: string): void {
        this.idleReason = reason;
        this.logger.info(`Review is idle for ${this.folder.uri.fsPath}: ${reason}`);
        this.emitter.fire();
    }

    private repositoryProblem(error: unknown): string {
        if (error instanceof GitCommandError) {
            const detail = error.stderr.trim().split('\n')[0] ?? '';
            return /not a git repository/i.test(detail) ? 'no git repository was found' : `git cannot open the repository: ${detail}`;
        }
        return `git could not be started: ${error instanceof Error ? error.message : String(error)}`;
    }

    private async recover(engine: ReviewEngine): Promise<void> {
        try {
            if (await engine.recovery.hasJournals()) {
                const recovered = await engine.repository.withStoreLock(() => engine.recovery.recoverLocked());
                this.logger.info(`Recovery: ${recovered} interrupted moves finished or rolled back`);
            }
        } catch (error) {
            this.logger.error('Recovery of interrupted moves failed, it is retried before the next move', error);
        }
    }

    private async runMove(requests: readonly LevelMoveRequest[], target: ReviewLevel): Promise<LevelMoveReport> {
        const engine = this.engine;
        const passes = this.passes;
        let report: LevelMoveReport = { failures: [], refusals: [], stalePaths: [] };
        if (!this.isStarted || !engine || !passes || requests.length === 0) {
            return report;
        }
        const files = new Set(requests.map(request => request.repoPath)).size;
        this.logger.info(`Move requested to ${target}: ${requests.length} level selections in ${files} files${requests.length <= 3 ? ` (${requests.map(request => `${request.repoPath} from ${request.sourceLevel}${request.changeIds ? ` changes ${Array.from(request.changeIds).join(',')}` : ''}`).join('; ')})` : ''}`);
        this.logger.debug(`Move requested to ${target}, all selections: ${requests.map(request => `${request.repoPath} from ${request.sourceLevel}`).join('; ')}`);
        const location = files >= NOTIFICATION_PROGRESS_THRESHOLD ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window;
        await vscode.window.withProgress({ location, title: `Sonara Review: moving ${files} files to ${LEVEL_LABELS[target]}` }, async progress => {
            await this.runExclusive(async () => {
                const startedAt = Date.now();
                const result = await engine.mover.move(requests, target, message => progress.report({ message }));
                report = result.report;
                progress.report({ message: 'Refreshing the list' });
                const rescan = new Set(passes.applyMoved(result.applied));
                this.emitter.fire();
                const settled = new Set(result.applied.filter(move => !rescan.has(move.repoPath)).map(move => move.repoPath));
                (await passes.changedSince(result.applied)).forEach(repoPath => settled.delete(repoPath));
                const refresh = Array.from(new Set(requests.map(request => request.repoPath))).filter(repoPath => !settled.has(repoPath));
                const refreshedAt = Date.now();
                if (refresh.length > 0) {
                    await passes.partial(refresh.map(repoPath => engine.scope.absolutePath(repoPath)), true);
                }
                this.logger.info(`Move to ${target} finished in ${Date.now() - startedAt}ms: ${result.applied.length} files moved, ${settled.size} shown straight from the move, ${refresh.length} files rescanned in ${Date.now() - refreshedAt}ms`);
            });
        });
        this.emitter.fire();
        return report;
    }

    private queuePaths(repoPaths: readonly string[]): void {
        repoPaths.forEach(repoPath => this.pendingPaths.add(this.absolutePath(repoPath)));
        void this.drain();
    }

    private onRepositoryChange(change: RepositoryChange): void {
        this.logger.info(`Repository change: full=${change.isFull} stash=${change.isStashChanged} recheck=${change.isRecheckNeeded} paths=${change.paths.length} recordFiles=${change.recordFiles.length}`);
        this.isFullPending = this.isFullPending || change.isFull;
        this.isStashPending = this.isStashPending || change.isStashChanged;
        change.paths.forEach(fsPath => this.pendingPaths.add(fsPath));
        change.recordFiles.forEach(fsPath => this.pendingRecordFiles.add(fsPath));
        if (change.isRecheckNeeded) {
            this.passes?.listedPaths().forEach(fsPath => this.pendingPaths.add(fsPath));
        }
        void this.drain();
    }

    private async drain(): Promise<void> {
        const passes = this.passes;
        if (this.isDraining || !passes) {
            return;
        }
        this.isDraining = true;
        try {
            while (!this.isDisposed && (this.isFullPending || this.isStashPending || this.pendingPaths.size > 0 || this.pendingRecordFiles.size > 0)) {
                const isFull = this.isFullPending;
                const isStashChanged = this.isStashPending;
                const fsPaths = Array.from(this.pendingPaths);
                const recordFiles = Array.from(this.pendingRecordFiles);
                this.isFullPending = false;
                this.isStashPending = false;
                this.pendingPaths.clear();
                this.pendingRecordFiles.clear();
                try {
                    await this.runExclusive(async () => {
                        if (isFull) {
                            await passes.full();
                        } else {
                            await passes.partial(fsPaths, false);
                            await passes.reloadRecords(recordFiles);
                        }
                        if (isStashChanged) {
                            await passes.checkStashes();
                        }
                    });
                    this.emitter.fire();
                } catch (error) {
                    this.logger.error('Review recompute failed', error);
                }
            }
        } finally {
            this.isDraining = false;
        }
    }

    private runExclusive(task: () => Promise<void>): Promise<void> {
        const run = this.exclusive.then(async () => {
            const writesBefore = this.store.writeCount();
            this.runningTasks++;
            try {
                await task();
            } finally {
                this.runningTasks--;
                if (this.store.writeCount() !== writesBefore) {
                    this.collector?.schedule();
                }
            }
        });
        this.exclusive = run.catch(() => undefined);
        return run;
    }

    dispose(): void {
        this.isDisposed = true;
        this.disposables.forEach(d => d.dispose());
        this.emitter.dispose();
    }
}
