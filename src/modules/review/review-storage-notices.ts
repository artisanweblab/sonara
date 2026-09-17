import * as vscode from 'vscode';
import { ReviewLogger } from './logging/review-logger';
import { RecordBlobRepair } from './store/record-blob-repair';
import { ReviewStateStore } from './store/review-state-store';
import { ReviewStorageError } from './store/review-storage-error';
import { StorageHealth, StorageProblem } from './store/storage-health';

export class ReviewStorageNotices {
    private readonly warned = new Set<string>();

    constructor(
        private readonly store: ReviewStateStore,
        private readonly repair: RecordBlobRepair,
        private readonly health: StorageHealth,
        private readonly logger: ReviewLogger,
        private readonly refresh: (repoPath: string) => void,
    ) {
        health.onProblem(problem => this.onProblem(problem));
    }

    async onEvaluationError(repoPath: string, error: unknown): Promise<void> {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ReviewStorageError && error.kind === 'blob-missing' && error.blobHash) {
            await this.onMissingBlob(repoPath, error.blobHash, message);
            return;
        }
        this.logger.error(`Review levels of ${repoPath} could not be read, they are shown from git only`, error);
        this.warnOnce(`${repoPath}\0${message}`, `Sonara Review: the review levels of ${repoPath} could not be read (${message}). Its changes are shown as New and Staged Changes only.`);
    }

    private async onMissingBlob(repoPath: string, hash: string, message: string): Promise<void> {
        const outcome = await this.repair.repair(repoPath, hash);
        if (outcome.kind === 'unreferenced' || outcome.kind === 'present') {
            this.logger.info(`Review levels of ${repoPath}: ${message}, but the stored record no longer needs it; refreshing`);
            this.refresh(repoPath);
            return;
        }
        if (outcome.kind === 'refused') {
            this.logger.error(`Accepted version for ${repoPath} is missing and its record could not be cleaned up, blob cleanup is paused`, `${message}; ${outcome.reason}`);
            this.health.report(
                { kind: 'blob-missing', location: `${this.store.recordFile(repoPath)}#${hash}`, reason: message, quarantinedTo: null },
                async () => (await this.repair.repair(repoPath, hash)).kind !== 'refused',
            );
            return;
        }
        const levels = outcome.levels.length > 0 ? outcome.levels.join(', ') : 'unknown levels';
        this.logger.info(`Accepted version ${hash} of ${repoPath} is gone from the blob store: ${levels} dropped to New, its review record removed`);
        this.warnOnce(repoPath, `Sonara Review: the accepted version of ${repoPath} behind ${levels} is no longer in .vscode/sonara/review/blobs. Its changes start again from New; the rest of the review is unaffected.`);
        this.refresh(repoPath);
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
                this.warnOnce(problem.location, `Sonara Review: an accepted version of ${repoPath} is missing from .vscode/sonara/review/blobs and its record could not be cleaned up. Its levels are shown from git only, and blob cleanup is paused.`);
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
