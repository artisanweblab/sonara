import { Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWrite } from '../../../shared/fs-utils';
import { DormantRecord, FrontierRecord } from '../types';
import { mapLimit } from '../model/map-limit';
import { isErrorCode } from './directory-lock';
import { encodeRecord } from './record-codec';
import { RecordPathIndex, RecordRoot } from './record-path-index';
import { RecordQuarantine } from './record-quarantine';
import { ActiveRead, DormantRead, RecordReader } from './record-reader';
import { ReviewBlobStore } from './review-blob-store';
import { ReviewStorageError } from './review-storage-error';
import { StorageHealth } from './storage-health';

const RECORD_EXTENSION = '.json';
const READ_CONCURRENCY = 32;

export interface RecordPair {
    active: FrontierRecord | null;
    dormant: DormantRecord | null;
    legacy: unknown;
    isObsoleteDormant: boolean;
    isNewerVersion: boolean;
}

export interface RecordChange {
    active?: FrontierRecord | null;
    dormant?: DormantRecord | null;
    blobs?: readonly Buffer[];
}

export interface RecordLocation {
    root: RecordRoot;
    repoPath: string;
}

export class ReviewStateStore {
    private readonly roots: Record<RecordRoot, string>;
    private readonly index = new RecordPathIndex();
    private readonly quarantine: RecordQuarantine;
    private readonly reader: RecordReader;
    private writes = 0;

    constructor(
        reviewRoot: string,
        private readonly health: StorageHealth,
        private readonly blobs: ReviewBlobStore,
    ) {
        this.roots = { files: path.join(reviewRoot, 'files'), dormant: path.join(reviewRoot, 'dormant') };
        this.quarantine = new RecordQuarantine(reviewRoot);
        this.reader = new RecordReader(health, this.quarantine);
    }

    writeCount(): number {
        return this.writes;
    }

    locate(fsPath: string): RecordLocation | null {
        for (const root of ['files', 'dormant'] as const) {
            const relative = path.relative(this.roots[root], fsPath);
            if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith(RECORD_EXTENSION) || path.basename(relative).startsWith('.')) {
                continue;
            }
            return { root, repoPath: relative.slice(0, -RECORD_EXTENSION.length).split(path.sep).join('/') };
        }
        return null;
    }

    recordFile(repoPath: string): string {
        return this.filePath('files', repoPath);
    }

    async refreshLocation(fsPath: string): Promise<RecordLocation | null> {
        const location = this.locate(fsPath);
        if (location) {
            this.index.set(location.root, location.repoPath, await this.exists(fsPath));
        }
        return location;
    }

    knownPaths(root: RecordRoot): string[] {
        return this.index.list(root);
    }

    async listStoredPaths(): Promise<string[]> {
        const paths = await this.listPaths(this.roots.files);
        this.index.replace('files', paths);
        return paths;
    }

    async listDormantPaths(): Promise<string[]> {
        const paths = await this.listPaths(this.roots.dormant);
        this.index.replace('dormant', paths);
        return paths;
    }

    referencedByQuarantine(): Promise<Set<string>> {
        return this.quarantine.referencedHashes();
    }

    async read(repoPath: string): Promise<FrontierRecord | null> {
        return (await this.readActive(repoPath)).record;
    }

    async readActive(repoPath: string): Promise<ActiveRead> {
        const result = await this.reader.readActive(repoPath, this.filePath('files', repoPath));
        this.index.set('files', repoPath, result.exists);
        return result;
    }

    async readDormant(repoPath: string): Promise<DormantRead> {
        const result = await this.reader.readDormant(repoPath, this.filePath('dormant', repoPath));
        this.index.set('dormant', repoPath, result.exists);
        return result;
    }

    async readPair(repoPath: string): Promise<RecordPair> {
        const active = await this.readActive(repoPath);
        const dormant = await this.readDormant(repoPath);
        return {
            active: active.record,
            legacy: active.legacy,
            dormant: dormant.record,
            isObsoleteDormant: dormant.isObsolete,
            isNewerVersion: active.isNewerVersion || dormant.isNewerVersion,
        };
    }

    async recordModifiedAt(repoPath: string): Promise<number | null> {
        try {
            return (await fs.stat(this.filePath('files', repoPath))).mtimeMs;
        } catch {
            return null;
        }
    }

    withStoreLock<T>(task: () => Promise<T>): Promise<T> {
        return this.blobs.withCollectionLock(task);
    }

    async readPairs(repoPaths: readonly string[]): Promise<Map<string, RecordPair>> {
        const ordered = Array.from(new Set(repoPaths));
        const pairs = await mapLimit(ordered, READ_CONCURRENCY, repoPath => this.readPair(repoPath));
        return new Map(ordered.map((repoPath, position) => [repoPath, pairs[position]]));
    }

    async transact(repoPath: string, mutation: (pair: RecordPair) => Promise<RecordChange> | RecordChange): Promise<RecordPair> {
        return this.withStoreLock(async () => {
            const pair = await this.readPair(repoPath);
            const change = await mutation(pair);
            if (change.active === undefined && change.dormant === undefined) {
                return pair;
            }
            for (const blob of change.blobs ?? []) {
                await this.blobs.write(blob);
            }
            await this.write(repoPath, pair, change);
            return this.applied(pair, change);
        });
    }

    async writeActive(repoPath: string, record: FrontierRecord | null): Promise<void> {
        await this.writeOrDelete('files', repoPath, record && Object.keys(record.frontiers).length > 0 ? record : null);
    }

    private applied(pair: RecordPair, change: RecordChange): RecordPair {
        const updated: RecordPair = { ...pair };
        if (change.active !== undefined) {
            updated.active = change.active && Object.keys(change.active.frontiers).length > 0 ? change.active : null;
            updated.legacy = null;
        }
        if (change.dormant !== undefined) {
            updated.dormant = change.dormant && Object.keys(change.dormant.frontiers).length > 0 ? change.dormant : null;
            updated.isObsoleteDormant = false;
        }
        return updated;
    }

    private async write(repoPath: string, pair: RecordPair, change: RecordChange): Promise<void> {
        if (pair.isNewerVersion) {
            throw new ReviewStorageError('record-newer-version', `Sonara Review: the review record of ${repoPath} was written by a newer Sonara and is left untouched`);
        }
        const updated = this.applied(pair, change);
        if (change.active !== undefined) {
            await this.writeOrDelete('files', repoPath, updated.active);
        }
        if (change.dormant !== undefined) {
            await this.writeOrDelete('dormant', repoPath, updated.dormant);
        }
    }

    private async writeOrDelete(root: RecordRoot, repoPath: string, record: FrontierRecord | null): Promise<void> {
        const target = this.filePath(root, repoPath);
        this.writes++;
        if (!record) {
            await fs.rm(target, { force: true });
            this.index.set(root, repoPath, false);
            await this.removeEmptyParents(path.dirname(target), this.roots[root]);
            return;
        }
        const content = encodeRecord(repoPath, record);
        for (let attempt = 0; ; attempt++) {
            await fs.mkdir(path.dirname(target), { recursive: true });
            try {
                await atomicWrite(target, content);
                this.index.set(root, repoPath, true);
                return;
            } catch (error) {
                if (!isErrorCode(error, 'ENOENT') || attempt >= 2) {
                    throw error;
                }
            }
        }
    }

    private async exists(fsPath: string): Promise<boolean> {
        try {
            await fs.access(fsPath);
            return true;
        } catch {
            return false;
        }
    }

    private async listPaths(root: string): Promise<string[]> {
        const result: string[] = [];
        let isComplete = true;
        const walk = async (dir: string): Promise<void> => {
            let entries: Dirent[];
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch (error) {
                if (!isErrorCode(error, 'ENOENT')) {
                    isComplete = false;
                    this.health.report({ kind: 'directory-unreadable', location: dir, reason: error instanceof Error ? error.message : String(error), quarantinedTo: null });
                }
                return;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(full);
                } else if (entry.isFile() && entry.name.endsWith(RECORD_EXTENSION) && !entry.name.startsWith('.')) {
                    result.push(path.relative(root, full).slice(0, -RECORD_EXTENSION.length).split(path.sep).join('/'));
                }
            }
        };
        await walk(root);
        if (isComplete) {
            this.health.recoveredDirectoriesUnder(root);
        }
        return result;
    }

    private filePath(root: RecordRoot, repoPath: string): string {
        return path.join(this.roots[root], ...this.segments(repoPath)) + RECORD_EXTENSION;
    }

    private async removeEmptyParents(dir: string, root: string): Promise<void> {
        let current = dir;
        while (current.startsWith(root + path.sep)) {
            try {
                await fs.rmdir(current);
            } catch {
                return;
            }
            current = path.dirname(current);
        }
    }

    private segments(repoPath: string): string[] {
        const parts = repoPath.split('/');
        if (parts.some(part => part === '' || part === '.' || part === '..')) {
            throw new Error(`Sonara Review: invalid repository path "${repoPath}"`);
        }
        return parts;
    }
}
