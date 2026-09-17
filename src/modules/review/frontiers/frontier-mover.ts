import { ComputePool } from '../compute/compute-pool';
import { ComputeTask } from '../compute/compute-tasks';
import { BlobHasher } from '../git/blob-hasher';
import { GitRepositoryState } from '../git/git-repository-state';
import { IndexTarget } from '../git/index-target';
import { GitEntries, SnapshotBatchLoader } from '../git/snapshot-batch-loader';
import { ReviewLogger } from '../logging/review-logger';
import { describeGeneration, recordId } from '../model/file-generation';
import { MISSING_MODE, sha256 } from '../model/file-state';
import { mapLimit } from '../model/map-limit';
import { textBlobReferences } from '../store/record-codec';
import { RecordPair } from '../store/review-state-store';
import { ReviewBlobStore } from '../store/review-blob-store';
import { ReviewStorageError } from '../store/review-storage-error';
import { FileGeneration, FrontierRecord, ReviewAtomState } from '../types';
import { FrontierRepository } from './frontier-repository';
import { CommitEntry, MoveCommitter } from './move-committer';
import { MoveCommand, MoveOutcome, refused } from './move-outcome';
import { PlannedChange } from './move-planner';
import { SpecialFileMover } from './special-file-mover';

const PREPARE_CHUNK = 400;
const BLOB_WRITE_CONCURRENCY = 16;

export interface AppliedMove {
    repoPath: string;
    generation: FileGeneration;
    record: FrontierRecord | null;
    atoms: ReviewAtomState[] | null;
    stamp: string | null;
    isIndexChanged: boolean;
}

export interface MoveBatch {
    outcomes: MoveOutcome[];
    applied: AppliedMove[];
}

export type MoveProgress = (message: string) => void;

interface PreparedEntry {
    command: MoveCommand;
    entry: CommitEntry;
    atoms: ReviewAtomState[] | null;
    stamp: string | null;
}

interface PhaseTimes {
    snapshots: number;
    blobs: number;
    compute: number;
    writes: number;
}

function errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).split('\n')[0];
}

function elapsedSince(startedAt: number): number {
    return Date.now() - startedAt;
}

function acceptedVersions(command: MoveCommand, pair: RecordPair | undefined, head: string): string[] {
    const active = pair?.active;
    return active?.kind === 'text' && command.file.kind === 'text' && active.baseHead === head ? textBlobReferences(active) : [];
}

export class FrontierMover {
    constructor(
        private readonly snapshots: SnapshotBatchLoader,
        private readonly special: SpecialFileMover,
        private readonly repository: FrontierRepository,
        private readonly blobs: ReviewBlobStore,
        private readonly hasher: BlobHasher,
        private readonly pool: ComputePool,
        private readonly committer: MoveCommitter,
        private readonly gitState: GitRepositoryState,
        private readonly logger: ReviewLogger,
    ) {}

    async move(commands: readonly MoveCommand[], progress: MoveProgress): Promise<MoveBatch> {
        const startedAt = Date.now();
        const outcomes = new Map<MoveCommand, MoveOutcome>();
        const runnable: MoveCommand[] = [];
        for (const command of commands) {
            this.logger.debug(`Move ${command.file.path} (${command.file.kind}): ${command.source} -> ${command.target}, ${command.changeIds ? `changes ${Array.from(command.changeIds).join(',')}` : 'all changes on the level'}, expected ${describeGeneration(command.generation)}`);
            if (command.source === command.target) {
                outcomes.set(command, refused(`${command.file.path}: the changes are already on that level.`));
            } else {
                runnable.push(command);
            }
        }
        const prepared: PreparedEntry[] = [];
        const times: PhaseTimes = { snapshots: 0, blobs: 0, compute: 0, writes: 0 };
        if (runnable.length > 0) {
            try {
                await this.repository.tracked(() => this.prepare(runnable, outcomes, prepared, times, progress));
            } catch (error) {
                this.logger.error(`Move preparation of ${runnable.length} files failed`, error);
                runnable.filter(command => !outcomes.has(command)).forEach(command => outcomes.set(command, { kind: 'failed', message: errorMessage(error) }));
                prepared.length = 0;
            }
        }
        const prepareMs = elapsedSince(startedAt);
        progress(`Saving ${prepared.length} files`);
        const commitStartedAt = Date.now();
        const summary = await this.committer.commit(prepared.map(item => item.entry));
        const applied: AppliedMove[] = [];
        for (const item of prepared) {
            const outcome = summary.outcomes.get(item.entry) ?? { kind: 'failed', message: 'the move did not run' };
            outcomes.set(item.command, outcome);
            if (outcome.kind === 'moved') {
                applied.push({
                    repoPath: item.command.file.path,
                    generation: outcome.generation,
                    record: item.entry.record,
                    atoms: item.atoms,
                    stamp: item.stamp,
                    isIndexChanged: item.entry.indexWrite !== null,
                });
            }
        }
        const counts = new Map<string, number>();
        outcomes.forEach(outcome => counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1));
        this.logger.info(`Move of ${commands.length} files: ${Array.from(counts, ([kind, count]) => `${kind} ${count}`).join(', ')}; prepare ${prepareMs}ms (snapshots ${times.snapshots}ms, accepted versions ${times.blobs}ms, diff ${times.compute}ms, copies and git objects ${times.writes}ms), commit ${elapsedSince(commitStartedAt)}ms (waited ${summary.lockWaitMs}ms for the lock, ${summary.recordsWritten} records, ${summary.indexEntriesWritten} staged entries)`);
        return { outcomes: commands.map(command => outcomes.get(command) ?? { kind: 'failed', message: 'the move did not run' }), applied };
    }

    private async prepare(runnable: readonly MoveCommand[], outcomes: Map<MoveCommand, MoveOutcome>, prepared: PreparedEntry[], times: PhaseTimes, progress: MoveProgress): Promise<void> {
        const head = await this.gitState.currentHead();
        const pairs = await this.repository.readPairs(runnable.map(command => command.file.path));
        const written = new Set<string>();
        for (const command of runnable.filter(candidate => candidate.file.kind === 'special')) {
            const move = await this.special.prepare(command, head);
            if (move.outcome) {
                outcomes.set(command, move.outcome);
            } else if (move.indexTarget) {
                const [indexWrite] = await this.resolveTargets([{ repoPath: command.file.path, target: move.indexTarget }]);
                prepared.push({
                    command,
                    entry: { repoPath: command.file.path, generation: move.generation, expectedRecordId: null, isRecordChanged: false, record: null, blobHashes: [], indexWrite },
                    atoms: null,
                    stamp: null,
                });
            }
        }
        const normal = runnable.filter(candidate => candidate.file.kind !== 'special');
        const listedAt = Date.now();
        const entries = await this.snapshots.entries(normal.map(command => command.file.path), head);
        times.snapshots += elapsedSince(listedAt);
        for (let start = 0; start < normal.length; start += PREPARE_CHUNK) {
            const chunk = normal.slice(start, start + PREPARE_CHUNK);
            progress(`Preparing files ${start + 1}-${start + chunk.length} of ${normal.length}`);
            await this.prepareChunk(chunk, head, entries, pairs, outcomes, prepared, written, times);
        }
    }

    private async prepareChunk(
        commands: readonly MoveCommand[],
        head: string,
        entries: GitEntries,
        pairs: ReadonlyMap<string, RecordPair>,
        outcomes: Map<MoveCommand, MoveOutcome>,
        prepared: PreparedEntry[],
        written: Set<string>,
        times: PhaseTimes,
    ): Promise<void> {
        let phaseStartedAt = Date.now();
        const loads = await this.snapshots.load(commands.map(command => command.file.path), head, entries);
        times.snapshots += elapsedSince(phaseStartedAt);
        phaseStartedAt = Date.now();
        const contents = await this.blobs.readMany(commands.flatMap(command => acceptedVersions(command, pairs.get(command.file.path), head)));
        times.blobs += elapsedSince(phaseStartedAt);
        const tasks: ComputeTask[] = [];
        const tasked: MoveCommand[] = [];
        for (const command of commands) {
            const load = loads.get(command.file.path);
            const pair = pairs.get(command.file.path) as RecordPair;
            const blobs = new Map<string, Buffer>();
            const needed = acceptedVersions(command, pair, head);
            const failure = needed.map(hash => contents.get(hash)).find((content): content is ReviewStorageError => content instanceof ReviewStorageError);
            if (!load || 'error' in load || failure) {
                const problem = failure ?? (load && 'error' in load ? load.error : new Error('the file could not be read'));
                this.logger.error(`Move of ${command.file.path} failed`, problem);
                outcomes.set(command, { kind: 'failed', message: errorMessage(problem) });
                continue;
            }
            needed.forEach(hash => blobs.set(hash, contents.get(hash) as Buffer));
            tasks.push({ kind: 'plan', input: { command, head, pair: { active: pair.active, hasLegacy: pair.legacy !== null, isNewerVersion: pair.isNewerVersion }, snapshot: load.snapshot, blobs } });
            tasked.push(command);
        }
        phaseStartedAt = Date.now();
        const results = await this.pool.run(tasks);
        times.compute += elapsedSince(phaseStartedAt);
        phaseStartedAt = Date.now();
        const changes: { command: MoveCommand; change: PlannedChange; stamp: string }[] = [];
        results.forEach((result, position) => {
            const command = tasked[position];
            if (result.kind === 'error') {
                this.logger.info(`Move of ${command.file.path} failed: ${result.message}`);
                outcomes.set(command, { kind: 'failed', message: result.message });
            } else if (result.kind === 'plan' && result.plan.kind === 'outcome') {
                outcomes.set(command, result.plan.outcome);
            } else if (result.kind === 'plan' && result.plan.kind === 'change') {
                const load = loads.get(command.file.path);
                changes.push({ command, change: result.plan.change, stamp: load && 'snapshot' in load ? load.snapshot.worktree.stamp : '' });
            }
        });
        await this.writeBlobs(changes.flatMap(item => item.change.newBlobs), written);
        const targets = await this.resolveTargets(changes.map(item => ({ repoPath: item.command.file.path, target: item.change.indexTarget })));
        changes.forEach((item, position) => {
            const change = item.change;
            this.logger.debug(`Move ${item.command.file.path}: ${change.changeCount} changes, record rewritten: ${change.isRecordChanged}, index write: ${change.indexTarget !== null}`);
            prepared.push({
                command: item.command,
                entry: {
                    repoPath: item.command.file.path,
                    generation: change.generation,
                    expectedRecordId: recordId(pairs.get(item.command.file.path)?.active ?? null),
                    isRecordChanged: change.isRecordChanged,
                    record: change.record,
                    blobHashes: change.record ? textBlobReferences(change.record) : [],
                    indexWrite: targets[position],
                },
                atoms: change.atoms,
                stamp: item.stamp,
            });
        });
        times.writes += elapsedSince(phaseStartedAt);
    }

    private async writeBlobs(contents: readonly Buffer[], written: Set<string>): Promise<void> {
        const pending = new Map<string, Buffer>();
        for (const content of contents) {
            const hash = sha256(content);
            if (!written.has(hash)) {
                pending.set(hash, content);
            }
        }
        await mapLimit(Array.from(pending), BLOB_WRITE_CONCURRENCY, async ([hash, content]) => {
            await this.blobs.write(content);
            written.add(hash);
        });
    }

    private async resolveTargets(items: readonly { repoPath: string; target: IndexTarget | null }[]): Promise<({ mode: string; objectId: string | null } | null)[]> {
        const blobs = items.flatMap(item => item.target?.kind === 'blob' ? [{ repoPath: item.repoPath, mode: item.target.mode, content: item.target.content }] : []);
        const objectIds = await this.hasher.hashMany(blobs);
        let next = 0;
        return items.map(item => {
            const target = item.target;
            if (!target) {
                return null;
            }
            switch (target.kind) {
                case 'remove':
                    return { mode: MISSING_MODE, objectId: null };
                case 'object':
                    return { mode: target.mode, objectId: target.objectId };
                case 'blob':
                    return { mode: target.mode, objectId: objectIds[next++] };
            }
        });
    }
}
