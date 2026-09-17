import * as path from 'path';
import { reviewDirIn } from '../../../shared/sonara-paths';
import { GitCommandError } from '../git/git-command-error';
import { GitReader } from '../git/git-reader';
import { ReviewLogger } from '../logging/review-logger';
import { silentProgress } from '../progress-runner';
import { ReviewEngine, createReviewEngine } from '../review-engine';
import { ReviewPasses } from '../review-passes';
import { ReviewBlobStore } from '../store/review-blob-store';
import { ReviewStateStore } from '../store/review-state-store';
import { ReviewStorageError } from '../store/review-storage-error';
import { StorageHealth } from '../store/storage-health';
import { LevelDocument, ReviewFileState, ReviewLevel } from '../types';
import { CliError } from './cli-error';

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 120;

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export interface UnreadableFile {
    path: string;
    reason: string;
}

export class ReviewSession {
    private passes: ReviewPasses;
    private unreadable = new Map<string, string>();

    private constructor(
        private readonly engine: ReviewEngine,
        private readonly store: ReviewStateStore,
        private readonly logger: ReviewLogger,
    ) {
        this.passes = this.newPasses();
    }

    static async open(projectPath: string, logger: ReviewLogger): Promise<ReviewSession> {
        const gitPath = process.env.SONARA_REVIEW_GIT ?? 'git';
        const folderPath = path.resolve(projectPath);
        const repoRoot = await ReviewSession.repositoryRoot(folderPath, logger, gitPath);
        const reviewRoot = reviewDirIn(folderPath);
        const blobs = new ReviewBlobStore(reviewRoot);
        const store = new ReviewStateStore(reviewRoot, new StorageHealth(), blobs, true);
        let session: ReviewSession | undefined;
        const engine = createReviewEngine({
            folderPath,
            repoRoot,
            reviewRoot,
            gitPath,
            store,
            blobs,
            logger,
            getFile: repoPath => session?.file(repoPath),
        });
        session = new ReviewSession(engine, store, logger);
        return session;
    }

    get repositoryRoot(): string {
        return this.engine.scope.repoRoot;
    }

    get head(): string {
        return this.passes.getHead();
    }

    files(): ReviewFileState[] {
        return this.passes.getFiles();
    }

    file(repoPath: string): ReviewFileState | undefined {
        return this.passes.getFile(repoPath);
    }

    unreadableFiles(): UnreadableFile[] {
        return Array.from(this.unreadable, ([path, reason]) => ({ path, reason }));
    }

    async read<T>(action: () => Promise<T>): Promise<T> {
        for (let attempt = 1; ; attempt++) {
            this.passes = this.newPasses();
            this.unreadable.clear();
            let thrown: ReviewStorageError | null = null;
            let result: T | undefined;
            try {
                await this.passes.full();
                result = await action();
            } catch (error) {
                if (!(error instanceof ReviewStorageError)) {
                    throw error;
                }
                thrown = error;
            }
            const isLastAttempt = attempt >= ATTEMPTS;
            if (!thrown && (this.unreadable.size === 0 || isLastAttempt)) {
                return result as T;
            }
            if (isLastAttempt) {
                throw new CliError(
                    'review-data-changing',
                    `the review data could not be read consistently after ${ATTEMPTS} attempts: ${(thrown as ReviewStorageError).message}`,
                );
            }
            await delay(RETRY_DELAY_MS * attempt);
        }
    }

    async levelDocument(repoPath: string, level: ReviewLevel): Promise<LevelDocument> {
        const file = this.passes.getFile(repoPath);
        if (!file) {
            throw new CliError('not-changed', `git does not report "${repoPath}" as changed, so it has no review levels`);
        }
        const head = this.passes.getHead();
        try {
            return await this.engine.evaluator.document(file.scanned, head, await this.passes.usableRecord(repoPath), level);
        } catch (error) {
            if (!(error instanceof ReviewStorageError) || error.kind !== 'blob-missing') {
                throw error;
            }
            this.unreadable.set(repoPath, error.message);
            this.logger.info(`Review levels of ${repoPath} are shown from git only: ${error.message}`);
            return await this.engine.evaluator.document(file.scanned, head, null, level);
        }
    }

    resolveRepoPath(input: string): string {
        const scope = this.engine.scope;
        if (path.isAbsolute(input)) {
            return scope.toRepoPath(path.resolve(input)) ?? input;
        }
        const asRepoPath = input.split(path.sep).join('/').replace(/^\.\//, '');
        if (this.passes.getFile(asRepoPath)) {
            return asRepoPath;
        }
        const fromWorkingDirectory = scope.toRepoPath(path.resolve(process.cwd(), input));
        if (fromWorkingDirectory && this.passes.getFile(fromWorkingDirectory)) {
            return fromWorkingDirectory;
        }
        return scope.isInScope(asRepoPath) ? asRepoPath : fromWorkingDirectory ?? asRepoPath;
    }

    dispose(): void {
        this.engine.pool.dispose();
    }

    private newPasses(): ReviewPasses {
        return new ReviewPasses(
            this.engine,
            this.store,
            this.logger,
            () => false,
            (repoPath, error) => {
                this.unreadable.set(repoPath, error instanceof Error ? error.message : String(error));
            },
            silentProgress,
        );
    }

    private static async repositoryRoot(folderPath: string, logger: ReviewLogger, gitPath: string): Promise<string> {
        try {
            const [topLevel] = await new GitReader(folderPath, logger, gitPath).lines(['rev-parse', '--show-toplevel']);
            if (!topLevel) {
                throw new CliError('no-repository', `git returned an empty repository path for ${folderPath}`);
            }
            return path.resolve(topLevel);
        } catch (error) {
            if (error instanceof CliError) {
                throw error;
            }
            const detail = error instanceof GitCommandError ? error.stderr.trim().split('\n')[0] : String(error);
            throw new CliError('no-repository', `no git repository for ${folderPath}: ${detail}`);
        }
    }
}
