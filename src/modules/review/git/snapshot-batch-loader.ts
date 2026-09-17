import { GITLINK_MODE, MISSING_MODE, UNMERGED_STATE } from '../model/file-state';
import { mapLimit } from '../model/map-limit';
import { ContentLoader, FileSnapshot, GitSide, IndexEntry, IndexSide } from './content-loader';
import { chunkPathspecs, literal } from './diff-options';
import { GitReader } from './git-reader';
import { EMPTY_TREE } from './git-repository-state';
import { ParsedIndexEntry, parseIndexEntries } from './index-entries';
import { ObjectBatchReader, ObjectRequest, objectKey } from './object-batch-reader';

const WHOLE_SCOPE_THRESHOLD = 64;
const WORKTREE_CONCURRENCY = 32;
const TREE_TYPE = 'tree';

export type SnapshotLoad = { snapshot: FileSnapshot } | { error: unknown };

export interface GitEntries {
    head: ReadonlyMap<string, IndexEntry>;
    index: ReadonlyMap<string, ParsedIndexEntry>;
}

export class SnapshotBatchLoader {
    constructor(
        private readonly reader: GitReader,
        private readonly objects: ObjectBatchReader,
        private readonly loader: ContentLoader,
        private readonly projectPrefix: string,
    ) {}

    async entries(repoPaths: readonly string[], head: string): Promise<GitEntries> {
        const paths = Array.from(new Set(repoPaths));
        const [headEntries, indexEntries] = await Promise.all([this.treeEntries(paths, new Set(paths), head), this.indexEntries(paths)]);
        return { head: headEntries, index: indexEntries };
    }

    async load(repoPaths: readonly string[], head: string, known: GitEntries | null = null): Promise<Map<string, SnapshotLoad>> {
        const paths = Array.from(new Set(repoPaths));
        const loads = new Map<string, SnapshotLoad>();
        if (paths.length === 0) {
            return loads;
        }
        const { head: headEntries, index: indexEntries } = known ?? await this.entries(paths, head);
        const requests: ObjectRequest[] = [];
        for (const repoPath of paths) {
            const headEntry = headEntries.get(repoPath);
            if (headEntry && headEntry.mode !== GITLINK_MODE) {
                requests.push({ repoPath, ...headEntry });
            }
            const index = indexEntries.get(repoPath);
            if (index?.objectId && index.mode !== GITLINK_MODE) {
                requests.push({ repoPath, mode: index.mode, objectId: index.objectId });
            }
        }
        const contents = await this.objects.readMany(requests);
        const contentOf = (repoPath: string, entry: IndexEntry): Buffer | null =>
            entry.mode === GITLINK_MODE ? null : contents.get(objectKey({ repoPath, ...entry })) ?? null;
        await mapLimit(paths, WORKTREE_CONCURRENCY, async repoPath => {
            const headEntry = headEntries.get(repoPath);
            const head: GitSide = headEntry ? { ...headEntry, content: contentOf(repoPath, headEntry) } : { mode: MISSING_MODE, objectId: null, content: null };
            const parsed = indexEntries.get(repoPath) as ParsedIndexEntry;
            const index: IndexSide = {
                ...parsed,
                content: parsed.objectId === null ? null : contentOf(repoPath, { mode: parsed.mode, objectId: parsed.objectId }),
            };
            try {
                const worktree = await this.loader.worktree(repoPath, index.state === UNMERGED_STATE ? index.conflictMode : index.mode);
                loads.set(repoPath, { snapshot: { head, index, worktree } });
            } catch (error) {
                loads.set(repoPath, { error });
            }
        });
        return loads;
    }

    private async treeEntries(paths: readonly string[], wanted: ReadonlySet<string>, head: string): Promise<Map<string, IndexEntry>> {
        const entries = new Map<string, IndexEntry>();
        if (head === EMPTY_TREE) {
            return entries;
        }
        const collect = (record: string): void => {
            const tab = record.indexOf('\t');
            const repoPath = record.slice(tab + 1);
            const [mode, type, objectId] = record.slice(0, tab).split(' ');
            if (type !== TREE_TYPE && wanted.has(repoPath)) {
                entries.set(repoPath, { mode, objectId });
            }
        };
        if (paths.length > WHOLE_SCOPE_THRESHOLD) {
            (await this.reader.nulRecords(['ls-tree', '-r', '-z', head, ...(this.projectPrefix ? ['--', this.projectPrefix] : [])])).forEach(collect);
            return entries;
        }
        for (const chunk of chunkPathspecs(paths)) {
            (await this.reader.nulRecords(['ls-tree', '-z', head, '--', ...chunk.map(spec => spec.slice(literal('').length))])).forEach(collect);
        }
        return entries;
    }

    async indexEntries(paths: readonly string[]): Promise<Map<string, ParsedIndexEntry>> {
        const wanted = new Set(paths);
        const grouped = new Map<string, string[]>();
        const collect = (record: string): void => {
            const repoPath = record.slice(record.indexOf('\t') + 1);
            if (wanted.has(repoPath)) {
                grouped.set(repoPath, [...(grouped.get(repoPath) ?? []), record]);
            }
        };
        if (paths.length > WHOLE_SCOPE_THRESHOLD) {
            (await this.reader.nulRecords(['ls-files', '-s', '-z', '--', this.projectPrefix ? literal(this.projectPrefix) : '.'])).forEach(collect);
        } else {
            for (const chunk of chunkPathspecs(paths)) {
                (await this.reader.nulRecords(['ls-files', '-s', '-z', '--', ...chunk])).forEach(collect);
            }
        }
        return new Map(paths.map(repoPath => [repoPath, parseIndexEntries(grouped.get(repoPath) ?? [], repoPath)]));
    }
}
