import * as vscode from 'vscode';
import { existsOnDisk } from '../../shared/file-actions';
import { literal } from './git/diff-options';
import { runGit } from './git/git-process';
import { ReviewLogger } from './logging/review-logger';
import { ReviewScope } from './review-scope';

export interface RevertTarget {
    repoPath: string;
    isInHead: boolean;
}

export interface RevertReport {
    reverted: string[];
    failures: string[];
}

export class ReviewFileReverter {
    constructor(
        private readonly gitPath: string,
        private readonly repoRoot: string,
        private readonly scope: ReviewScope,
        private readonly logger: ReviewLogger,
    ) {}

    async revert(targets: readonly RevertTarget[]): Promise<RevertReport> {
        const report: RevertReport = { reverted: [], failures: [] };
        for (const target of targets) {
            try {
                await this.revertOne(target);
                report.reverted.push(target.repoPath);
            } catch (error) {
                this.logger.error(`Revert of ${target.repoPath} failed`, error);
                report.failures.push(`${target.repoPath}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        this.logger.info(`Revert finished: ${report.reverted.length} files restored, ${report.failures.length} failed`);
        return report;
    }

    private async revertOne(target: RevertTarget): Promise<void> {
        const spec = literal(target.repoPath);
        if (target.isInHead) {
            await runGit(this.gitPath, this.repoRoot, ['restore', '--source=HEAD', '--staged', '--worktree', '--', spec]);
            return;
        }
        await runGit(this.gitPath, this.repoRoot, ['rm', '--cached', '-f', '--ignore-unmatch', '--', spec]);
        const uri = vscode.Uri.file(this.scope.absolutePath(target.repoPath));
        if (await existsOnDisk(uri)) {
            await vscode.workspace.fs.delete(uri, { useTrash: true });
        }
    }
}
