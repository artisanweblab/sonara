import { MISSING_MODE, SYMLINK_MODE, UNMERGED_STATE, UNREADABLE_STATE, indexStateId, modeOfState } from '../model/file-state';
import { splitWorkingLines } from '../model/hunk-key';
import { mapLimit } from '../model/map-limit';
import { FileChange, Hunk, ScannedFile, ScannedFileKind } from '../types';
import { ContentLoader, gitlinkWorktreeState } from './content-loader';
import { DiffParser, RawEntry } from './diff-parser';
import { DIFF_FLAGS } from './diff-options';
import { GitRepositoryState } from './git-repository-state';
import { GitReader } from './git-reader';
import { WorktreeState } from './worktree-file';

const BINARY_PROBE_BYTES = 8000;
const FILE_READ_CONCURRENCY = 16;
const ABSENT_MODE = '000000';
const SHA1_EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const SHA256_EMPTY_BLOB = '473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813';

export interface ScanResult {
    head: string;
    files: ScannedFile[];
}

function changesByPath(changes: readonly FileChange[]): Map<string, FileChange> {
    const byPath = new Map<string, FileChange>();
    for (const change of changes) {
        const existing = byPath.get(change.path);
        if (!existing || existing.isUnmerged) {
            byPath.set(change.path, { ...change, isUnmerged: change.isUnmerged || (existing?.isUnmerged ?? false) });
        }
    }
    return byPath;
}

function kindOf(changes: readonly (FileChange | undefined)[], modes: readonly (string | undefined)[]): ScannedFileKind {
    if (changes.some(change => change?.isSubmodule || change?.isUnmerged)) {
        return 'special';
    }
    return changes.some(change => change?.isBinary) || modes.includes(SYMLINK_MODE) ? 'opaque' : 'text';
}

function isOpaqueContent(worktree: WorktreeState): boolean {
    return worktree.mode === SYMLINK_MODE || (worktree.content !== null && worktree.content.subarray(0, BINARY_PROBE_BYTES).includes(0));
}

function wholeFileHunk(content: Buffer): Hunk[] {
    const text = content.toString('utf8');
    const lines = splitWorkingLines(text);
    if (lines.length === 0) {
        return [];
    }
    return [{
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        removedLines: [],
        addedLines: lines,
        removedNoNewlineAtEof: false,
        addedNoNewlineAtEof: !text.endsWith('\n'),
    }];
}

function indexStateOf(stagedChange: RawEntry | undefined, unstagedChange: RawEntry | undefined, isUnmerged: boolean): string {
    if (isUnmerged || stagedChange?.status.startsWith('U') || unstagedChange?.status.startsWith('U')) {
        return UNMERGED_STATE;
    }
    if (stagedChange) {
        return stagedChange.dstMode === ABSENT_MODE ? MISSING_MODE : indexStateId(stagedChange.dstMode, stagedChange.dstOid);
    }
    if (unstagedChange && unstagedChange.srcMode === ABSENT_MODE && unstagedChange.status.startsWith('A')) {
        return indexStateId(unstagedChange.dstMode, unstagedChange.dstOid.length === SHA256_EMPTY_BLOB.length ? SHA256_EMPTY_BLOB : SHA1_EMPTY_BLOB);
    }
    if (unstagedChange) {
        return unstagedChange.srcMode === ABSENT_MODE ? MISSING_MODE : indexStateId(unstagedChange.srcMode, unstagedChange.srcOid);
    }
    return MISSING_MODE;
}

export class ChangeScanner {
    constructor(
        private readonly reader: GitReader,
        private readonly loader: ContentLoader,
        private readonly gitState: GitRepositoryState,
        private readonly reviewRepoPath: string,
    ) {}

    async scan(pathspecs: readonly string[], includes: (repoPath: string) => boolean = (): boolean => true): Promise<ScanResult> {
        const specs = [...pathspecs, `:(exclude,literal)${this.reviewRepoPath}`];
        const head = await this.gitState.currentHead();
        const staged = new DiffParser();
        await this.reader.stream(['diff', '--cached', head, ...DIFF_FLAGS, '--', ...specs], '\n', line => staged.push(line));
        const unstaged = new DiffParser();
        await this.reader.stream(['diff', ...DIFF_FLAGS, '--', ...specs], '\n', line => unstaged.push(line));
        const untracked = await this.reader.nulRecords(['ls-files', '--others', '--exclude-standard', '-z', '--', ...specs]);

        const stagedChange = changesByPath(staged.finish());
        const unstagedChange = changesByPath(unstaged.finish());
        const stagedRaw = staged.rawEntries();
        const pendingRaw = unstaged.rawEntries();
        const trackedPaths = new Set([...stagedChange.keys(), ...unstagedChange.keys()].filter(includes));
        const untrackedPaths = new Set(untracked.filter(entry => !entry.endsWith('/')));
        const trackedFiles = await mapLimit(Array.from(trackedPaths), FILE_READ_CONCURRENCY, repoPath => this.trackedFile(
            repoPath,
            stagedChange.get(repoPath),
            unstagedChange.get(repoPath),
            [stagedRaw.get(repoPath), pendingRaw.get(repoPath)],
            untrackedPaths.has(repoPath),
        ));
        const untrackedEntries = untracked.filter(entry => !trackedPaths.has(entry) && includes(entry.endsWith('/') ? entry.slice(0, -1) : entry));
        const untrackedFiles = await mapLimit(untrackedEntries, FILE_READ_CONCURRENCY, entry => this.untrackedFile(entry));
        return {
            head,
            files: [...trackedFiles, ...untrackedFiles.filter((file): file is ScannedFile => file !== null)],
        };
    }

    private async trackedFile(
        repoPath: string,
        stagedChange: FileChange | undefined,
        unstagedChange: FileChange | undefined,
        raw: readonly (RawEntry | undefined)[],
        isAlsoUntracked: boolean,
    ): Promise<ScannedFile> {
        const isUnmerged = stagedChange?.isUnmerged === true || unstagedChange?.isUnmerged === true;
        const indexState = indexStateOf(raw[0], raw[1], isUnmerged);
        const isGitlink = stagedChange?.isSubmodule === true || unstagedChange?.isSubmodule === true;
        const indexMode = isUnmerged ? (await this.loader.indexSide(repoPath)).conflictMode : modeOfState(indexState);
        const worktree = isGitlink ? null : await this.readWorktree(repoPath, indexMode);
        const modes = raw.flatMap(entry => entry ? [entry.srcMode, entry.dstMode] : []);
        const base = {
            path: repoPath,
            stagedHunks: stagedChange?.hunks ?? [],
            hasStagedChange: stagedChange !== undefined,
            worktreeState: worktree ? worktree.state : gitlinkWorktreeState(unstagedChange, indexState),
            indexState,
            isUnreadable: worktree?.state === UNREADABLE_STATE,
        };
        if (worktree?.state === UNREADABLE_STATE) {
            return { ...base, kind: 'special', newHunks: unstagedChange?.hunks ?? [], hasNewChange: unstagedChange !== undefined || isAlsoUntracked };
        }
        if (isAlsoUntracked && worktree && worktree.content !== null) {
            const isOpaque = isOpaqueContent(worktree) || kindOf([stagedChange], modes) === 'opaque';
            return { ...base, kind: isOpaque ? 'opaque' : 'text', newHunks: isOpaque ? [] : wholeFileHunk(worktree.content), hasNewChange: true };
        }
        return {
            ...base,
            kind: kindOf([stagedChange, unstagedChange], [...modes, worktree?.mode]),
            newHunks: unstagedChange?.hunks ?? [],
            hasNewChange: unstagedChange !== undefined,
        };
    }

    private async untrackedFile(entry: string): Promise<ScannedFile | null> {
        const repoPath = entry.endsWith('/') ? entry.slice(0, -1) : entry;
        const base = {
            path: repoPath,
            stagedHunks: [],
            hasStagedChange: false,
            hasNewChange: true,
            indexState: MISSING_MODE,
            isUnreadable: false,
        };
        if (entry.endsWith('/')) {
            return { ...base, kind: 'special', newHunks: [], worktreeState: `directory:${repoPath}` };
        }
        const worktree = await this.readWorktree(repoPath, null);
        if (worktree.state === UNREADABLE_STATE) {
            return { ...base, kind: 'special', newHunks: [], worktreeState: worktree.state, isUnreadable: true };
        }
        if (worktree.content === null) {
            return null;
        }
        const isOpaque = isOpaqueContent(worktree);
        return {
            ...base,
            kind: isOpaque ? 'opaque' : 'text',
            newHunks: isOpaque ? [] : wholeFileHunk(worktree.content),
            worktreeState: worktree.state,
        };
    }

    private async readWorktree(repoPath: string, indexMode: string | null): Promise<WorktreeState> {
        try {
            return await this.loader.worktree(repoPath, indexMode);
        } catch {
            return { mode: MISSING_MODE, content: null, state: UNREADABLE_STATE, stamp: UNREADABLE_STATE };
        }
    }
}
