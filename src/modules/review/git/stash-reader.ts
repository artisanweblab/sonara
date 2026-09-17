import { MISSING_MODE, fileStateId } from '../model/file-state';
import { ContentLoader } from './content-loader';
import { GitReader, STASH_LOG_ARGS } from './git-reader';
import { GitRepositoryState } from './git-repository-state';

export interface StashEntry {
    oid: string;
    createdAtMs: number;
    parents: string[];
}

export class StashReader {
    constructor(
        private readonly reader: GitReader,
        private readonly loader: ContentLoader,
        private readonly gitState: GitRepositoryState,
    ) {}

    async list(): Promise<StashEntry[]> {
        if (!(await this.gitState.hasStash())) {
            return [];
        }
        const lines = await this.reader.lines([...STASH_LOG_ARGS]);
        return lines.filter(line => line.trim() !== '').map(line => {
            const [oid, seconds, ...parents] = line.trim().split(' ');
            return { oid, createdAtMs: Number(seconds) * 1000, parents };
        });
    }

    async findHolding(
        repoPath: string,
        head: string,
        worktreeState: string,
        reviewedAtMs: number | null,
        stashes: readonly StashEntry[],
    ): Promise<StashEntry | null> {
        const reviewedAtSecond = reviewedAtMs === null ? null : Math.floor(reviewedAtMs / 1000) * 1000;
        for (const stash of stashes) {
            if (stash.parents[0] !== head || (reviewedAtSecond !== null && stash.createdAtMs < reviewedAtSecond)) {
                continue;
            }
            if (await this.holds(repoPath, stash, worktreeState)) {
                return stash;
            }
        }
        return null;
    }

    private async holds(repoPath: string, stash: StashEntry, worktreeState: string): Promise<boolean> {
        const trees = stash.parents.length > 2 ? [stash.oid, stash.parents[2]] : [stash.oid];
        for (const tree of trees) {
            const side = await this.loader.treeSide(repoPath, tree);
            if (side.mode !== MISSING_MODE) {
                return fileStateId(side.mode, side.content) === worktreeState;
            }
        }
        return worktreeState === MISSING_MODE;
    }
}
