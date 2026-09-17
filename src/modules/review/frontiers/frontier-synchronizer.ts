import { ContentLoader } from '../git/content-loader';
import { GitRepositoryState } from '../git/git-repository-state';
import { StashReader } from '../git/stash-reader';
import { ReviewLogger } from '../logging/review-logger';
import { LegacyRecordMigrator } from '../migration/legacy-record-migrator';
import { contentHash } from '../model/file-state';
import { HASH_VALUES, SEGMENT_VALUES } from '../model/ladder-values';
import { rebaseFrontiers } from '../model/level-ladder';
import { mapLimit } from '../model/map-limit';
import { recordId } from '../model/file-generation';
import { RECORD_VERSION } from '../store/record-codec';
import { RecordChange, RecordPair } from '../store/review-state-store';
import { DormantRecord, FrontierRecord, ReviewFileState, ScannedFile } from '../types';
import { toSegments } from '../model/segment-codec';
import { EncodedRecord } from './frontier-encoding';
import { FrontierRepository } from './frontier-repository';
import { PassStashes } from './pass-stashes';

const SYNC_CONCURRENCY = 32;

export interface SynchronizeInput {
    head: string;
    files: ReadonlyMap<string, ScannedFile>;
    candidatePaths: readonly string[];
    previous: ReadonlyMap<string, ReviewFileState>;
    stashes: PassStashes;
}

export class FrontierSynchronizer {
    constructor(
        private readonly loader: ContentLoader,
        private readonly gitState: GitRepositoryState,
        private readonly repository: FrontierRepository,
        private readonly migrator: LegacyRecordMigrator,
        private readonly stashReader: StashReader,
        private readonly logger: ReviewLogger,
    ) {}

    async synchronize(input: SynchronizeInput): Promise<Map<string, FrontierRecord | null>> {
        const isOperationInProgress = await this.gitState.isOperationInProgress();
        if (isOperationInProgress) {
            this.logger.info('Sync: a rebase, merge or cherry-pick is in progress, HEAD migration and legacy migration are deferred');
        }
        const records = new Map<string, FrontierRecord | null>();
        await mapLimit(Array.from(new Set(input.candidatePaths)), SYNC_CONCURRENCY, async repoPath => {
            const file = input.files.get(repoPath);
            if (file?.isUnreadable) {
                this.logger.debug(`Sync: ${repoPath} cannot be read, its review record is left untouched`);
                records.set(repoPath, null);
                return;
            }
            try {
                const unlocked = await this.repository.readPair(repoPath);
                if (unlocked.isNewerVersion) {
                    this.logger.debug(`Sync: ${repoPath} review record was written by a newer Sonara, it is left untouched and not shown`);
                    records.set(repoPath, null);
                    return;
                }
                const pair = await this.needsChange(unlocked, file, input, isOperationInProgress)
                    ? await this.repository.transact(repoPath, current => this.reconcile(repoPath, current, file, input, isOperationInProgress))
                    : unlocked;
                if (file) {
                    const isUsable = pair.active !== null && pair.active.baseHead === input.head && pair.active.kind === file.kind;
                    records.set(repoPath, isUsable ? pair.active : null);
                }
            } catch (error) {
                this.logger.error(`Sync: ${repoPath} could not be synchronized, its levels are shown from git only`, error);
                if (file) {
                    records.set(repoPath, null);
                }
            }
        });
        return records;
    }

    async pruneDormant(head: string, stashes: PassStashes, processed: ReadonlySet<string>): Promise<void> {
        const isOperationInProgress = await this.gitState.isOperationInProgress();
        for (const repoPath of this.repository.knownPaths('dormant')) {
            if (processed.has(repoPath)) {
                continue;
            }
            try {
                const pair = await this.repository.readPair(repoPath);
                if (!pair.isNewerVersion && await this.isDormantDead(pair, head, stashes, isOperationInProgress)) {
                    await this.repository.transact(repoPath, async current =>
                        await this.isDormantDead(current, head, stashes, isOperationInProgress) ? { dormant: null } : {});
                    this.logger.info(`Sync: ${repoPath} dormant record deleted, its stash is gone or HEAD changed`);
                }
            } catch (error) {
                this.logger.error(`Sync: dormant record of ${repoPath} could not be checked`, error);
            }
        }
    }

    private async isDormantDead(pair: RecordPair, head: string, stashes: PassStashes, isOperationInProgress: boolean): Promise<boolean> {
        if (pair.isObsoleteDormant) {
            return true;
        }
        const dormant = pair.dormant;
        return dormant !== null && ((dormant.baseHead !== head && !isOperationInProgress) || !(await stashes.has(dormant.stashOid)));
    }

    private async needsChange(pair: RecordPair, file: ScannedFile | undefined, input: SynchronizeInput, isOperationInProgress: boolean): Promise<boolean> {
        const active = pair.active;
        if (pair.legacy !== null || pair.isObsoleteDormant || (!file && active) || (file && active && active.kind !== file.kind)) {
            return true;
        }
        if (active && active.baseHead !== input.head && !isOperationInProgress) {
            return true;
        }
        if (!pair.dormant) {
            return false;
        }
        return file !== undefined || await this.isDormantDead(pair, input.head, input.stashes, isOperationInProgress);
    }

    private async reconcile(
        repoPath: string,
        pair: RecordPair,
        file: ScannedFile | undefined,
        input: SynchronizeInput,
        isOperationInProgress: boolean,
    ): Promise<RecordChange> {
        const change: RecordChange = {};
        let active = pair.active;
        if (pair.legacy !== null && !active) {
            if (!file) {
                change.active = null;
                this.logger.info(`Sync: ${repoPath} legacy record dropped, the file is not changed in git`);
            } else if (!isOperationInProgress) {
                const migrated = await this.migrator.migrate(file, input.head, pair.legacy);
                active = migrated.record;
                change.active = active;
                change.blobs = migrated.blobs;
                this.logger.info(`Sync: ${repoPath} legacy record migrated, frontiers: ${active ? Object.keys(active.frontiers).join(',') : 'none'}`);
            }
        }
        if (pair.isObsoleteDormant) {
            change.dormant = null;
            this.logger.info(`Sync: ${repoPath} dormant record from an older format deleted, it is not tied to a stash`);
        }
        if (active && file && active.kind !== file.kind) {
            this.logger.info(`Sync: ${repoPath} record dropped, kind changed from ${active.kind} to ${file.kind}`);
            active = null;
            change.active = null;
        }
        if (active && active.baseHead !== input.head) {
            if (isOperationInProgress) {
                this.logger.info(`Sync: ${repoPath} rebase from ${active.baseHead} deferred until the git operation ends`);
            } else {
                const previousFrontiers = Object.keys(active.frontiers).join(',');
                const rebased = file ? await this.rebase(active, input.head, file) : { record: null, blobs: [] };
                active = rebased.record;
                change.active = active;
                change.blobs = [...(change.blobs ?? []), ...rebased.blobs];
                this.logger.info(`Sync: ${repoPath} frontiers ${previousFrontiers} rebased onto ${input.head}: ${active ? Object.keys(active.frontiers).join(',') : 'none left'}${file ? '' : ' (file left the change list)'}`);
            }
        }
        await this.reconcileDormant(repoPath, pair.dormant, active, file, input, isOperationInProgress, change);
        if (!file && active) {
            change.dormant = await this.park(repoPath, active, input);
            change.active = null;
        }
        return change;
    }

    private async reconcileDormant(
        repoPath: string,
        dormant: DormantRecord | null,
        active: FrontierRecord | null,
        file: ScannedFile | undefined,
        input: SynchronizeInput,
        isOperationInProgress: boolean,
        change: RecordChange,
    ): Promise<void> {
        if (!dormant) {
            return;
        }
        if (dormant.baseHead !== input.head && !isOperationInProgress) {
            this.logger.info(`Sync: ${repoPath} dormant record deleted, HEAD changed`);
            change.dormant = null;
            return;
        }
        const stashAlive = await input.stashes.has(dormant.stashOid);
        if (!file) {
            if (!stashAlive) {
                this.logger.info(`Sync: ${repoPath} dormant record deleted, stash ${dormant.stashOid} is gone`);
                change.dormant = null;
            }
            return;
        }
        change.dormant = null;
        const isPopped = !stashAlive && await input.stashes.wasRemovedInThisPass(dormant.stashOid);
        if (!stashAlive && !isPopped) {
            this.logger.info(`Sync: ${repoPath} dormant record discarded, stash ${dormant.stashOid} was already gone before this refresh`);
            return;
        }
        if (!active && dormant.worktreeState === file.worktreeState && dormant.baseHead === input.head && dormant.kind === file.kind) {
            change.active = this.activeFromDormant(dormant);
            this.logger.info(`Sync: ${repoPath} dormant frontiers restored from stash ${dormant.stashOid} (${stashAlive ? 'still in the stash list' : 'removed in this refresh'}): ${Object.keys(dormant.frontiers).join(',')}`);
        } else {
            this.logger.info(`Sync: ${repoPath} dormant record discarded, the file came back with different content, mode or kind`);
        }
    }

    private async park(repoPath: string, active: FrontierRecord, input: SynchronizeInput): Promise<DormantRecord | null> {
        const previous = input.previous.get(repoPath);
        const worktreeState = previous?.generation.worktree ?? (await this.loader.worktree(repoPath, null)).state;
        const indexState = previous?.generation.index ?? (await this.loader.indexSide(repoPath)).state;
        const reviewedAt = await this.repository.recordModifiedAt(repoPath);
        const candidates = await input.stashes.madeAfterReview(repoPath, recordId(active));
        const stash = await this.stashReader.findHolding(repoPath, active.baseHead, worktreeState, reviewedAt, candidates);
        if (!stash) {
            this.logger.info(`Sync: ${repoPath} left the change list and no stash made after the last review holds its content, frontiers ${Object.keys(active.frontiers).join(',')} deleted`);
            return null;
        }
        this.logger.info(`Sync: ${repoPath} left the change list, frontiers parked as dormant with stash ${stash.oid}: ${Object.keys(active.frontiers).join(',')}`);
        return { ...active, worktreeState, indexState, stashOid: stash.oid };
    }

    private async rebase(record: FrontierRecord, head: string, file: ScannedFile): Promise<EncodedRecord> {
        if (!(await this.gitState.isCommitReadable(record.baseHead))) {
            this.logger.info(`Sync: ${file.path} old base ${record.baseHead} is not readable, levels fall back to New`);
            return { record: null, blobs: [] };
        }
        const oldHead = await this.loader.treeSide(file.path, record.baseHead);
        const newHead = await this.loader.treeSide(file.path, head);
        if (record.kind === 'opaque') {
            const frontiers = this.repository.opaqueFrontiers(record);
            return this.repository.encodeOpaque(file.path, head, {
                content: rebaseFrontiers(contentHash(oldHead.content), contentHash(newHead.content), frontiers.content, HASH_VALUES),
                modes: rebaseFrontiers(oldHead.mode, newHead.mode, frontiers.modes, HASH_VALUES),
            });
        }
        const frontiers = await this.repository.textFrontiers(record);
        return this.repository.encodeText(file.path, head, {
            content: rebaseFrontiers(toSegments(oldHead.content), toSegments(newHead.content), frontiers.content, SEGMENT_VALUES),
            modes: rebaseFrontiers(oldHead.mode, newHead.mode, frontiers.modes, HASH_VALUES),
        });
    }

    private activeFromDormant(dormant: DormantRecord): FrontierRecord {
        const record: FrontierRecord = { version: RECORD_VERSION, path: dormant.path, baseHead: dormant.baseHead, kind: dormant.kind, frontiers: dormant.frontiers };
        if (dormant.indexBase) {
            record.indexBase = dormant.indexBase;
        }
        return record;
    }
}
