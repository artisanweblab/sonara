import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FILE_MODE_CONFIG_ARGS, GitReader } from './git-reader';
import { statStamp } from './worktree-file';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const OPERATION_MARKERS: readonly string[] = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'];

export async function fileStamp(filePath: string): Promise<string> {
    try {
        return statStamp(await fs.lstat(filePath));
    } catch {
        return 'missing';
    }
}

export class GitRepositoryState {
    private gitDir: Promise<string> | undefined;
    private trustExecutable: Promise<boolean> | undefined;

    constructor(
        private readonly reader: GitReader,
        private readonly repoRoot: string,
    ) {}

    async currentHead(): Promise<string> {
        const lines = await this.reader.lines(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], [0, 1]);
        return lines[0] ? lines[0] : EMPTY_TREE;
    }

    async isCommitReadable(objectId: string): Promise<boolean> {
        if (objectId === EMPTY_TREE) {
            return true;
        }
        const lines = await this.reader.lines(['rev-parse', '--verify', '--quiet', `${objectId}^{commit}`], [0, 1]);
        return lines.length > 0 && lines[0] !== '';
    }

    trustExecutableBit(): Promise<boolean> {
        if (!this.trustExecutable) {
            this.trustExecutable = this.reader.lines([...FILE_MODE_CONFIG_ARGS], [0, 1]).then(lines => lines[0] !== 'false');
        }
        return this.trustExecutable;
    }

    async isOperationInProgress(): Promise<boolean> {
        const gitDir = await this.resolveGitDir();
        return OPERATION_MARKERS.some(marker => existsSync(path.join(gitDir, marker)));
    }

    async indexStamp(): Promise<string> {
        return fileStamp(await this.indexFile());
    }

    async indexFile(): Promise<string> {
        const [indexPath] = await this.reader.lines(['rev-parse', '--git-path', 'index']);
        return path.resolve(this.repoRoot, indexPath);
    }

    async resolveCommonDir(): Promise<string> {
        const [commonDir] = await this.reader.lines(['rev-parse', '--git-common-dir']);
        return path.resolve(this.repoRoot, commonDir);
    }

    resolveGitDir(): Promise<string> {
        if (!this.gitDir) {
            this.gitDir = this.reader.lines(['rev-parse', '--absolute-git-dir']).then(([gitDir]) => gitDir);
        }
        return this.gitDir;
    }

    async hasStash(): Promise<boolean> {
        const lines = await this.reader.lines(['rev-parse', '--verify', '--quiet', 'refs/stash'], [0, 1]);
        return lines.length > 0 && lines[0] !== '';
    }
}
