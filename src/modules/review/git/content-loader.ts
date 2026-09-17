import * as path from 'path';
import { GITLINK_MODE, MISSING_MODE, SYMLINK_MODE, UNMERGED_STATE, indexStateId } from '../model/file-state';
import { FileChange } from '../types';
import { literal } from './diff-options';
import { GitReader } from './git-reader';
import { EMPTY_TREE, GitRepositoryState } from './git-repository-state';
import { parseIndexEntries } from './index-entries';
import { WorktreeState, readWorktreeState } from './worktree-file';

export interface IndexEntry {
    mode: string;
    objectId: string;
}

export interface GitSide {
    mode: string;
    objectId: string | null;
    content: Buffer | null;
}

export interface IndexSide extends GitSide {
    state: string;
    conflictMode: string | null;
}

export interface FileSnapshot {
    head: GitSide;
    index: IndexSide;
    worktree: WorktreeState;
}

const MISSING_SIDE: GitSide = { mode: MISSING_MODE, objectId: null, content: null };
const SUBPROJECT_COMMIT = /^Subproject commit ([0-9a-f]{40,64})/;

export function gitlinkWorktreeState(change: FileChange | undefined, indexState: string): string {
    if (!change) {
        return indexState;
    }
    if (change.status === 'deleted') {
        return MISSING_MODE;
    }
    const added = change.hunks.flatMap(hunk => hunk.addedLines).map(line => SUBPROJECT_COMMIT.exec(line)).find(match => match !== null);
    return added ? indexStateId(GITLINK_MODE, added[1]) : indexState;
}

export class ContentLoader {
    constructor(
        private readonly reader: GitReader,
        private readonly gitState: GitRepositoryState,
        private readonly repoRoot: string,
    ) {}

    async snapshot(repoPath: string, head: string): Promise<FileSnapshot> {
        const headSide = await this.treeSide(repoPath, head);
        const indexSide = await this.indexSide(repoPath, headSide);
        const worktree = await this.worktree(repoPath, indexSide.state === UNMERGED_STATE ? indexSide.conflictMode : indexSide.mode);
        return { head: headSide, index: indexSide, worktree };
    }

    async worktree(repoPath: string, indexMode: string | null): Promise<WorktreeState> {
        return readWorktreeState(this.absolutePath(repoPath), indexMode, await this.gitState.trustExecutableBit());
    }

    async treeSide(repoPath: string, treeish: string): Promise<GitSide> {
        const entry = await this.headEntry(repoPath, treeish);
        if (!entry) {
            return MISSING_SIDE;
        }
        return { ...entry, content: await this.objectContent(repoPath, entry) };
    }

    async indexSide(repoPath: string, head: GitSide | null = null): Promise<IndexSide> {
        const entry = parseIndexEntries(await this.reader.nulRecords(['ls-files', '-s', '-z', '--', literal(repoPath)]), repoPath);
        if (entry.objectId === null) {
            return { ...entry, content: null };
        }
        const content = head && head.objectId === entry.objectId
            ? head.content
            : await this.objectContent(repoPath, { mode: entry.mode, objectId: entry.objectId });
        return { ...entry, content };
    }

    async headEntry(repoPath: string, head: string): Promise<IndexEntry | null> {
        if (head === EMPTY_TREE) {
            return null;
        }
        const records = await this.reader.nulRecords(['ls-tree', '-z', head, '--', repoPath]);
        const entry = records.find(record => record.slice(record.indexOf('\t') + 1) === repoPath);
        if (!entry) {
            return null;
        }
        const [mode, , objectId] = entry.slice(0, entry.indexOf('\t')).split(' ');
        return { mode, objectId };
    }

    absolutePath(repoPath: string): string {
        return path.join(this.repoRoot, ...repoPath.split('/'));
    }

    private objectContent(repoPath: string, entry: IndexEntry): Promise<Buffer | null> {
        if (entry.mode === GITLINK_MODE) {
            return Promise.resolve(null);
        }
        return this.reader.buffer(entry.mode === SYMLINK_MODE
            ? ['cat-file', 'blob', entry.objectId]
            : ['cat-file', '--filters', `--path=${repoPath}`, entry.objectId]);
    }
}
