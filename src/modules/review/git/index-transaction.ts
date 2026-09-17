import * as fs from 'fs/promises';
import { MISSING_MODE, indexStateId, sha256 } from '../model/file-state';
import { LOCK_RETRY_DELAY_MS, delay, isErrorCode } from '../store/directory-lock';
import { chunkPathspecs, literal } from './diff-options';
import { IndexGit } from './index-git';
import { ParsedIndexEntry, parseIndexEntries } from './index-entries';
import { IndexWrite, IndexWriteResult } from './index-target';

const LOCK_TIMEOUT_MS = 5000;
const WHOLE_SCOPE_THRESHOLD = 64;

export interface LockIdentity {
    dev: number;
    ino: number;
    birthMs: number;
}

async function acquireLock(lockPath: string): Promise<fs.FileHandle> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        try {
            return await fs.open(lockPath, 'wx');
        } catch (error) {
            if (!isErrorCode(error, 'EEXIST')) {
                throw error;
            }
            if (Date.now() > deadline) {
                throw new Error(`Sonara Review: the git index is locked by another git process (${lockPath} exists)`);
            }
            await delay(LOCK_RETRY_DELAY_MS);
        }
    }
}

export class IndexTransaction {
    private finalContent: Buffer | null = null;
    private isCommitted = false;
    private isReleased = false;

    private constructor(
        private readonly git: IndexGit,
        readonly indexPath: string,
        readonly lockPath: string,
        private readonly handle: fs.FileHandle,
        readonly lockIdentity: LockIdentity,
        private readonly working: string,
    ) {}

    static async open(git: IndexGit, indexPath: string): Promise<IndexTransaction> {
        const lockPath = `${indexPath}.lock`;
        const handle = await acquireLock(lockPath);
        const working = `${indexPath}.sonara-${process.pid}-${Date.now()}`;
        try {
            const stat = await handle.stat();
            try {
                await fs.copyFile(indexPath, working);
            } catch (error) {
                if (!isErrorCode(error, 'ENOENT')) {
                    throw error;
                }
            }
            return new IndexTransaction(git, indexPath, lockPath, handle, { dev: stat.dev, ino: stat.ino, birthMs: stat.birthtimeMs }, working);
        } catch (error) {
            await handle.close().catch(() => undefined);
            await fs.rm(lockPath, { force: true });
            await fs.rm(working, { force: true });
            throw error;
        }
    }

    async entries(repoPaths: readonly string[], projectPrefix: string): Promise<Map<string, ParsedIndexEntry>> {
        const wanted = new Set(repoPaths);
        const grouped = new Map<string, string[]>();
        const specs = wanted.size > WHOLE_SCOPE_THRESHOLD
            ? [[projectPrefix ? literal(projectPrefix) : '.']]
            : chunkPathspecs(Array.from(wanted));
        for (const chunk of specs) {
            const output = await this.git.run(['ls-files', '-s', '-v', '-z', '--', ...chunk], this.env(), null);
            for (const record of output.toString('utf8').split('\0')) {
                const repoPath = record.slice(record.indexOf('\t') + 1);
                if (record.length > 0 && wanted.has(repoPath)) {
                    grouped.set(repoPath, [...(grouped.get(repoPath) ?? []), record]);
                }
            }
        }
        return new Map(Array.from(wanted, repoPath => [repoPath, parseIndexEntries(grouped.get(repoPath) ?? [], repoPath)]));
    }

    async apply(writes: readonly IndexWrite[], entries: ReadonlyMap<string, ParsedIndexEntry>): Promise<Map<string, IndexWriteResult>> {
        const results = new Map<string, IndexWriteResult>();
        const lines: string[] = [];
        for (const write of writes) {
            const entry = entries.get(write.repoPath) as ParsedIndexEntry;
            if (entry.hasPreservedFlags) {
                results.set(write.repoPath, { kind: 'flagged' });
            } else if (entry.state !== write.expectedState) {
                results.set(write.repoPath, { kind: 'stale', actual: entry.state });
            } else if (write.objectId === null) {
                if (entry.state !== MISSING_MODE) {
                    lines.push(`0 ${'0'.repeat(entry.objectId?.length ?? 40)}\t${write.repoPath}\0`);
                }
                results.set(write.repoPath, { kind: 'written', state: MISSING_MODE });
            } else {
                lines.push(`${write.mode} ${write.objectId}\t${write.repoPath}\0`);
                results.set(write.repoPath, { kind: 'written', state: indexStateId(write.mode, write.objectId) });
            }
        }
        if (lines.length > 0) {
            await this.git.run(['update-index', '-z', '--index-info'], this.env(), Buffer.from(lines.join(''), 'utf8'));
            this.finalContent = await fs.readFile(this.working);
        }
        return results;
    }

    hasChanges(): boolean {
        return this.finalContent !== null;
    }

    finalSha(): string {
        return this.finalContent ? sha256(this.finalContent) : '';
    }

    async commit(): Promise<void> {
        if (!this.finalContent) {
            return;
        }
        await this.handle.truncate(0);
        await this.handle.write(this.finalContent, 0, this.finalContent.length, 0);
        await this.handle.sync();
        await this.handle.close();
        await fs.rename(this.lockPath, this.indexPath);
        this.isCommitted = true;
    }

    async release(): Promise<void> {
        if (this.isReleased) {
            return;
        }
        this.isReleased = true;
        await fs.rm(this.working, { force: true }).catch(() => undefined);
        if (!this.isCommitted) {
            await this.handle.close().catch(() => undefined);
            await fs.rm(this.lockPath, { force: true });
        }
    }

    private env(): Readonly<Record<string, string>> {
        return { GIT_INDEX_FILE: this.working };
    }
}
