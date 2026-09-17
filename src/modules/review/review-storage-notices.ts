import * as vscode from 'vscode';
import { ReviewLogger } from './logging/review-logger';
import { textBlobReferences } from './store/record-codec';
import { ReviewBlobStore } from './store/review-blob-store';
import { ReviewStateStore } from './store/review-state-store';
import { ReviewStorageError } from './store/review-storage-error';
import { StorageHealth, StorageProblem } from './store/storage-health';

export class ReviewStorageNotices {
    private readonly warned = new Set<string>();

    constructor(
        private readonly store: ReviewStateStore,
        private readonly blobs: ReviewBlobStore,
        private readonly health: StorageHealth,
        private readonly logger: ReviewLogger,
        private readonly refresh: (repoPath: string) => void,
    ) {
        health.onProblem(problem => this.onProblem(problem));
    }

    async onEvaluationError(repoPath: string, error: unknown): Promise<void> {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ReviewStorageError && error.kind === 'blob-missing' && error.blobHash) {
            const hash = error.blobHash;
            if (await this.isStillMissing(repoPath, hash)) {
                this.health.report(
                    { kind: 'blob-missing', location: `${this.store.recordFile(repoPath)}#${hash}`, reason: message, quarantinedTo: null },
                    async () => !(await this.isStillMissing(repoPath, hash)),
                );
                return;
            }
            this.logger.info(`Review levels of ${repoPath}: ${message}, but the current record no longer names it; refreshing`);
            this.refresh(repoPath);
            return;
        }
        this.logger.error(`Review levels of ${repoPath} could not be read, they are shown from git only`, error);
        this.warnOnce(`${repoPath}\0${message}`, `Sonara Review: the review levels of ${repoPath} could not be read (${message}). Its changes are shown as New and Staged Changes only.`);
    }

    private isStillMissing(repoPath: string, hash: string): Promise<boolean> {
        return this.blobs.withCollectionLock(async () => {
            const record = await this.store.read(repoPath);
            return record !== null && textBlobReferences(record).includes(hash) && !(await this.blobs.exists(hash));
        });
    }

    private onProblem(problem: StorageProblem): void {
        const location = problem.location.split('#')[0];
        const repoPath = this.store.locate(location)?.repoPath ?? location;
        switch (problem.kind) {
            case 'record-unreadable':
                this.logger.error(`Review record ${problem.location} is unreadable${problem.quarantinedTo ? `, moved to ${problem.quarantinedTo}` : ' and could not be moved to quarantine, blob cleanup is paused'}`, problem.reason);
                this.warnOnce(problem.location, problem.quarantinedTo
                    ? `Sonara Review: the review record of ${repoPath} was unreadable and was moved to ${problem.quarantinedTo}. Its changes start again from New.`
                    : `Sonara Review: the review record ${problem.location} is unreadable and could not be moved to quarantine. Blob cleanup is paused until the file is fixed or removed.`);
                return;
            case 'record-newer-version':
                this.logger.error(`Review record ${problem.location} is left untouched, blob cleanup is paused`, problem.reason);
                this.warnOnce('newer-version', `Sonara Review: some review records (first: ${repoPath}) were written by a newer version of Sonara. They are left untouched and shown as New; update Sonara or reload this window.`);
                return;
            case 'blob-missing':
                this.logger.error(`Accepted version for ${repoPath} is missing while its record still names it, blob cleanup is paused`, problem.reason);
                this.warnOnce(problem.location, `Sonara Review: an accepted version of ${repoPath} is missing from .vscode/sonara/review/blobs. Its levels are shown from git only, and blob cleanup is paused.`);
                return;
            case 'directory-unreadable':
                this.logger.error(`Review storage folder ${problem.location} cannot be read, blob cleanup is paused`, problem.reason);
                this.warnOnce(problem.location, `Sonara Review: the folder ${problem.location} cannot be read (${problem.reason}). Review levels stored there are not shown, and blob cleanup is paused.`);
        }
    }

    private warnOnce(key: string, message: string): void {
        if (this.warned.has(key)) {
            return;
        }
        this.warned.add(key);
        void vscode.window.showWarningMessage(message);
    }
}
