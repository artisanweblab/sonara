import { realpathSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { REVIEW_FOLDER_NAME } from '../../shared/project-layout';

function toPosix(value: string): string {
    return value.split(path.sep).join('/');
}

function isOutside(relative: string): boolean {
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

export class ReviewScope {
    readonly projectPrefix: string;
    readonly reviewRepoPath: string;
    private readonly realFolder: string;

    constructor(
        private readonly folder: vscode.WorkspaceFolder,
        readonly repoRoot: string,
    ) {
        this.realFolder = this.realFolderPath();
        this.projectPrefix = toPosix(path.relative(repoRoot, this.realFolder));
        this.reviewRepoPath = this.projectPrefix ? `${this.projectPrefix}/${REVIEW_FOLDER_NAME}` : REVIEW_FOLDER_NAME;
    }

    absolutePath(repoPath: string): string {
        return path.join(this.repoRoot, ...repoPath.split('/'));
    }

    toRepoPath(fsPath: string): string | null {
        const roots: [string, string][] = [
            [this.folder.uri.fsPath, this.projectPrefix],
            [this.realFolder, this.projectPrefix],
            [this.repoRoot, ''],
        ];
        for (const [root, prefix] of roots) {
            const relative = path.relative(root, fsPath);
            if (isOutside(relative)) {
                continue;
            }
            const posix = toPosix(relative);
            const repoPath = prefix && posix ? `${prefix}/${posix}` : prefix || posix;
            return this.isInScope(repoPath) ? repoPath : null;
        }
        return null;
    }

    isInScope(repoPath: string): boolean {
        if (repoPath === '' || repoPath.split('/').includes('.git')) {
            return false;
        }
        if (repoPath === this.reviewRepoPath || repoPath.startsWith(`${this.reviewRepoPath}/`)) {
            return false;
        }
        return !this.projectPrefix || repoPath === this.projectPrefix || repoPath.startsWith(`${this.projectPrefix}/`);
    }

    private realFolderPath(): string {
        try {
            return realpathSync(this.folder.uri.fsPath);
        } catch {
            return this.folder.uri.fsPath;
        }
    }
}
