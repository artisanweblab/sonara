import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { AppliedMove } from './frontiers/frontier-mover';
import { FileEvaluation, gitAtoms, scanGeneration } from './frontiers/level-changes';
import { PassStashes } from './frontiers/pass-stashes';
import { StashHistory } from './frontiers/stash-history';
import { ScanResult } from './git/change-scanner';
import { chunkPathspecs, literal } from './git/diff-options';
import { fileStamp } from './git/git-repository-state';
import { ReviewLogger } from './logging/review-logger';
import { recordId } from './model/file-generation';
import { mapLimit } from './model/map-limit';
import { PathCoverage } from './model/path-coverage';
import { ReviewEngine } from './review-engine';
import { ReviewStateStore } from './store/review-state-store';
import { FrontierRecord, REVIEW_LEVELS, ReviewAtomState, ReviewFileState, ReviewLevel, ScannedFile } from './types';

const STAT_CONCURRENCY = 32;
const PATH_ORDER = new Intl.Collator();
const SCOPE_SCAN_THRESHOLD = 200;

function fileSignature(head: string, file: Omit<ReviewFileState, 'signature'>, record: FrontierRecord | null): string {
    const generation = file.generation;
    const hash = createHash('sha256').update(`${head}\0${generation.worktree}\0${generation.index}\0${generation.record}\0${JSON.stringify(record?.frontiers ?? {})}`);
    for (const state of file.atoms) {
        hash.update(`\0${state.atom.id}:${state.level}`);
    }
    return hash.digest('hex');
}

export type StorageErrorHandler = (repoPath: string, error: unknown) => void;

interface PendingEvaluation {
    file: ScannedFile;
    record: FrontierRecord | null;
}

export class ReviewPasses {
    private files = new Map<string, ReviewFileState>();
    private sorted: ReviewFileState[] | null = null;
    private readonly pathStamps = new Map<string, string>();
    private readonly history = new StashHistory();
    private indexStamp = '';
    private head = '';
    private knownStashes: ReadonlySet<string> | null = null;

    constructor(
        private readonly engine: ReviewEngine,
        private readonly store: ReviewStateStore,
        private readonly logger: ReviewLogger,
        private readonly isDisposed: () => boolean,
        private readonly onStorageError: StorageErrorHandler,
    ) {}

    getHead(): string {
        return this.head;
    }

    getFile(repoPath: string): ReviewFileState | undefined {
        return this.files.get(repoPath);
    }

    getFiles(): ReviewFileState[] {
        if (!this.sorted) {
            this.sorted = Array.from(this.files.values()).sort((a, b) => PATH_ORDER.compare(a.path, b.path));
        }
        return this.sorted;
    }

    getAtomsByLevel(): Map<ReviewLevel, ReviewAtomState[]> {
        const byLevel = new Map<ReviewLevel, ReviewAtomState[]>(REVIEW_LEVELS.map(level => [level, []]));
        for (const file of this.getFiles()) {
            for (const state of file.atoms) {
                byLevel.get(state.level)?.push(state);
            }
        }
        return byLevel;
    }

    async usableRecord(repoPath: string): Promise<FrontierRecord | null> {
        const record = await this.engine.repository.read(repoPath);
        const file = this.files.get(repoPath);
        return record && file && record.baseHead === this.head && record.kind === file.scanned.kind ? record : null;
    }

    listedPaths(): string[] {
        return Array.from(this.files.keys()).map(repoPath => this.engine.scope.absolutePath(repoPath));
    }

    async full(): Promise<void> {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'Sonara Review: scanning changes' },
            async () => {
                const startedAt = Date.now();
                this.history.beginPass();
                this.indexStamp = await this.engine.gitState.indexStamp();
                this.pathStamps.clear();
                const scan = await this.engine.scanner.scan([this.scopeSpec()]);
                const stamps = await mapLimit(scan.files, STAT_CONCURRENCY, file => fileStamp(this.engine.scope.absolutePath(file.path)));
                scan.files.forEach((file, position) => this.pathStamps.set(file.path, stamps[position]));
                await this.store.listStoredPaths();
                await this.store.listDormantPaths();
                const previous = this.files;
                this.replaceFiles(new Map());
                const stashes = this.passStashes();
                await stashes.entries();
                const processed = new Set<string>();
                await this.applyScan(scan, this.knownRecordPaths(() => true), previous, stashes, processed);
                await this.finishPass(stashes, processed);
                this.logScan('full scan', scan.files.length, startedAt);
            },
        );
    }

    async partial(fsPaths: readonly string[], isForced: boolean): Promise<void> {
        const scope = this.engine.scope;
        const inScope = Array.from(new Set(fsPaths.map(fsPath => scope.toRepoPath(fsPath)).filter((value): value is string => value !== null)));
        if (inScope.length === 0) {
            this.logger.debug(`Partial scan skipped: none of ${fsPaths.length} changed paths is inside the project scope`);
            return;
        }
        const indexStamp = await this.engine.gitState.indexStamp();
        const stamps = await mapLimit(inScope, STAT_CONCURRENCY, repoPath => fileStamp(scope.absolutePath(repoPath)));
        const repoPaths = inScope.filter((repoPath, position) => isForced || indexStamp !== this.indexStamp || this.pathStamps.get(repoPath) !== stamps[position]);
        if (repoPaths.length === 0) {
            this.logger.debug(`Partial scan skipped: ${inScope.length} paths reported by the watcher, working files and git index unchanged since the last scan`);
            return;
        }
        if (repoPaths.length < inScope.length) {
            this.logger.debug(`Partial scan: ${inScope.length - repoPaths.length} of ${inScope.length} reported paths unchanged, skipped`);
        }
        this.indexStamp = indexStamp;
        const startedAt = Date.now();
        this.history.beginPass();
        const stashes = this.passStashes();
        const processed = new Set<string>();
        const groups = repoPaths.length > SCOPE_SCAN_THRESHOLD
            ? [{ specs: [this.scopeSpec()], coverage: new PathCoverage(repoPaths) }]
            : chunkPathspecs(repoPaths).map(specs => ({ specs, coverage: new PathCoverage(specs.map(spec => spec.slice(literal('').length))) }));
        let scannedFiles = 0;
        for (const group of groups) {
            const covers = (repoPath: string): boolean => group.coverage.covers(repoPath);
            const scan = await this.engine.scanner.scan(group.specs, covers);
            scannedFiles += scan.files.length;
            if (this.isDisposed()) {
                return;
            }
            const previous = new Map<string, ReviewFileState>();
            for (const [repoPath, file] of this.files) {
                if (covers(repoPath)) {
                    previous.set(repoPath, file);
                }
            }
            previous.forEach((_file, repoPath) => this.deleteFile(repoPath));
            await this.applyScan(scan, this.knownRecordPaths(covers), previous, stashes, processed);
        }
        await this.finishPass(stashes, processed);
        const stampOf = new Map(inScope.map((repoPath, position) => [repoPath, stamps[position]]));
        repoPaths.forEach(repoPath => this.pathStamps.set(repoPath, stampOf.get(repoPath) ?? 'missing'));
        this.logScan(`partial scan of ${repoPaths.length} paths`, scannedFiles, startedAt);
    }

    async reloadRecords(recordFiles: readonly string[]): Promise<void> {
        if (recordFiles.length === 0) {
            return;
        }
        const locations = await mapLimit(recordFiles, STAT_CONCURRENCY, recordFile => this.store.refreshLocation(recordFile));
        const listed = Array.from(new Set(locations.flatMap(location => location?.root === 'files' && this.files.has(location.repoPath) ? [location.repoPath] : [])));
        const records = await mapLimit(listed, STAT_CONCURRENCY, repoPath => this.safeUsableRecord(repoPath));
        const changed: PendingEvaluation[] = [];
        listed.forEach((repoPath, position) => {
            const file = this.files.get(repoPath) as ReviewFileState;
            const record = records[position];
            if (recordId(record) !== file.generation.record || (record !== null) !== file.hasFrontiers) {
                changed.push({ file: file.scanned, record });
            }
        });
        if (changed.length === 0) {
            this.logger.debug(`Record events: ${recordFiles.length} record files already match the shown levels`);
            return;
        }
        this.history.beginPass();
        await this.evaluateFiles(changed);
        this.logger.info(`Record events: ${recordFiles.length} record files changed, ${changed.length} files re-evaluated`);
    }

    applyMoved(applied: readonly AppliedMove[]): string[] {
        this.history.beginPass();
        const rescan: string[] = [];
        for (const move of applied) {
            const earlier = this.files.get(move.repoPath);
            if (!earlier || move.atoms === null) {
                rescan.push(move.repoPath);
                continue;
            }
            this.setFile(earlier.scanned, move.generation, move.record, move.atoms);
            if (move.stamp !== null) {
                this.pathStamps.set(move.repoPath, move.stamp);
            }
            if (move.isIndexChanged) {
                rescan.push(move.repoPath);
            }
        }
        return rescan;
    }

    async changedSince(applied: readonly AppliedMove[]): Promise<string[]> {
        const checked = applied.filter(move => move.stamp !== null && !move.isIndexChanged);
        const stamps = await mapLimit(checked, STAT_CONCURRENCY, move => fileStamp(this.engine.scope.absolutePath(move.repoPath)));
        return checked.filter((move, position) => stamps[position] !== move.stamp).map(move => move.repoPath);
    }

    async checkStashes(): Promise<void> {
        this.history.beginPass();
        const stashes = this.passStashes();
        await stashes.entries();
        await this.finishPass(stashes, new Set());
        this.logger.info(`Stash check: ${this.knownStashes?.size ?? 0} stash entries, ${this.engine.repository.knownPaths('dormant').length} dormant records left`);
    }

    private async safeUsableRecord(repoPath: string): Promise<FrontierRecord | null> {
        try {
            return await this.usableRecord(repoPath);
        } catch (error) {
            this.onStorageError(repoPath, error);
            return null;
        }
    }

    private async applyScan(
        scan: ScanResult,
        knownRecordPaths: readonly string[],
        previous: ReadonlyMap<string, ReviewFileState>,
        stashes: PassStashes,
        processed: Set<string>,
    ): Promise<void> {
        if (this.isDisposed()) {
            return;
        }
        if (this.head !== '' && this.head !== scan.head) {
            this.logger.info(`HEAD changed from ${this.head} to ${scan.head}`);
        }
        this.head = scan.head;
        const scanned = new Map(scan.files.map(file => [file.path, file]));
        const paths = Array.from(new Set([...knownRecordPaths, ...scanned.keys()]));
        paths.forEach(repoPath => processed.add(repoPath));
        const records = await this.engine.synchronizer.synchronize({ head: scan.head, files: scanned, candidatePaths: paths, previous, stashes });
        const pending: PendingEvaluation[] = [];
        let reused = 0;
        for (const file of scan.files) {
            const record = records.get(file.path) ?? null;
            const earlier = previous.get(file.path);
            if (earlier && record && this.isSameEvaluation(earlier, file, record)) {
                this.setFile(file, earlier.generation, record, earlier.atoms);
                reused++;
            } else {
                pending.push({ file, record });
            }
        }
        await this.evaluateFiles(pending);
        if (reused > 0) {
            this.logger.debug(`Evaluation reused for ${reused} of ${scan.files.length} files, their HEAD, working file, staged version and record are unchanged`);
        }
    }

    private async evaluateFiles(items: readonly PendingEvaluation[]): Promise<void> {
        const withRecords: { file: ScannedFile; record: FrontierRecord }[] = [];
        for (const item of items) {
            if (item.file.kind === 'special' || !item.record) {
                this.setFile(item.file, scanGeneration(item.file, this.head), null, gitAtoms(item.file));
            } else {
                withRecords.push({ file: item.file, record: item.record });
            }
        }
        if (withRecords.length === 0) {
            return;
        }
        const outcomes = await this.engine.bulkEvaluator.evaluate(withRecords, this.head);
        for (const { file, record } of withRecords) {
            const outcome = outcomes.get(file.path);
            if (outcome && !('error' in outcome)) {
                this.setFile(file, outcome.generation, record, outcome.atoms);
                continue;
            }
            this.onStorageError(file.path, outcome ? outcome.error : new Error('the file was not evaluated'));
            this.setFile(file, scanGeneration(file, this.head), null, gitAtoms(file));
        }
    }

    private setFile(file: ScannedFile, generation: FileEvaluation['generation'], record: FrontierRecord | null, atoms: ReviewAtomState[]): void {
        const state = { path: file.path, scanned: file, generation, hasFrontiers: record !== null, atoms };
        this.files.set(file.path, { ...state, signature: fileSignature(this.head, state, record) });
        this.sorted = null;
        if (record) {
            this.history.confirm(file.path, generation.record);
        } else {
            this.history.forget(file.path);
        }
    }

    private deleteFile(repoPath: string): void {
        this.files.delete(repoPath);
        this.sorted = null;
    }

    private replaceFiles(files: Map<string, ReviewFileState>): void {
        this.files = files;
        this.sorted = null;
    }

    private isSameEvaluation(earlier: ReviewFileState, file: ScannedFile, record: FrontierRecord): boolean {
        const generation = earlier.generation;
        return earlier.hasFrontiers
            && earlier.scanned.kind === file.kind
            && generation.head === this.head
            && generation.worktree === file.worktreeState
            && generation.index === file.indexState
            && generation.record === recordId(record);
    }

    private passStashes(): PassStashes {
        return new PassStashes(this.engine.stashReader, this.knownStashes, this.history);
    }

    private async finishPass(stashes: PassStashes, processed: ReadonlySet<string>): Promise<void> {
        const hasDormant = this.engine.repository.knownPaths('dormant').length > 0;
        if (!hasDormant && !stashes.isLoaded()) {
            return;
        }
        const oids = await stashes.oids();
        const isChanged = this.knownStashes === null || oids.size !== this.knownStashes.size || Array.from(oids).some(oid => !this.knownStashes?.has(oid));
        if (hasDormant && isChanged) {
            await this.engine.synchronizer.pruneDormant(this.head, stashes, processed);
        }
        this.knownStashes = oids;
    }

    private scopeSpec(): string {
        return this.engine.scope.projectPrefix ? literal(this.engine.scope.projectPrefix) : '.';
    }

    private knownRecordPaths(covers: (repoPath: string) => boolean): string[] {
        const paths = [...this.store.knownPaths('files'), ...this.store.knownPaths('dormant')];
        return Array.from(new Set(paths.filter(repoPath => this.engine.scope.isInScope(repoPath) && covers(repoPath))));
    }

    private logScan(label: string, scannedFiles: number, startedAt: number): void {
        const totals = Array.from(this.getAtomsByLevel()).map(([level, states]) =>
            `${level} ${new Set(states.map(state => state.atom.path)).size}/${states.length}`).join(', ');
        this.logger.info(`${label}: ${scannedFiles} files in git, ${Date.now() - startedAt}ms, head ${this.head}; files/changes per level: ${totals}`);
    }
}
