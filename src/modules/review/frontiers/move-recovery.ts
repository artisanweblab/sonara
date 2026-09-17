import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { chunkPathspecs } from '../git/diff-options';
import { GitReader } from '../git/git-reader';
import { parseIndexEntries } from '../git/index-entries';
import { ReviewLogger } from '../logging/review-logger';
import { recordId } from '../model/file-generation';
import { sha256 } from '../model/file-state';
import { JournalDocument, JournalEntry, MoveJournal } from '../store/move-journal';
import { ProcessIdentity } from '../store/process-identity';
import { ReviewStateStore } from '../store/review-state-store';

type RecoveryOutcome = 'completed' | 'rolled back';

export class MoveRecovery {
    constructor(
        private readonly journal: MoveJournal,
        private readonly store: ReviewStateStore,
        private readonly reader: GitReader,
        private readonly logger: ReviewLogger,
    ) {}

    async hasJournals(): Promise<boolean> {
        return (await this.journal.list()).length > 0;
    }

    async recoverLocked(): Promise<number> {
        let recovered = 0;
        for (const file of await this.journal.list()) {
            const read = await this.journal.read(file);
            if (read.status === 'invalid') {
                const target = await this.journal.setAside(file);
                this.logger.error(`Recovery: move journal ${path.basename(file)} cannot be read, moved to ${path.basename(target)}; review levels of that move may be half applied`, read.reason);
                continue;
            }
            const document = read.document;
            if (await this.isOwnerRunning(document)) {
                this.logger.info(`Recovery: move journal ${path.basename(file)} belongs to running process ${document.pid}, left alone`);
                continue;
            }
            const outcome = await this.resolve(document);
            await this.journal.remove(file);
            recovered++;
            this.logger.info(`Recovery: interrupted move from process ${document.pid} (${document.createdAt}) ${outcome}, ${document.entries.length} review records${document.index ? `, ${document.index.states.length} staged entries` : ''}`);
        }
        return recovered;
    }

    private async isOwnerRunning(document: JournalDocument): Promise<boolean> {
        if (document.pid === process.pid || document.hostname !== os.hostname()) {
            return false;
        }
        return ProcessIdentity.isOwnerAlive(document.pid, document.identity ?? undefined);
    }

    private async resolve(document: JournalDocument): Promise<RecoveryOutcome> {
        const index = document.index;
        if (!index) {
            return await this.allWritten(document.entries) ? 'completed' : this.rollBack(document.entries);
        }
        const lock = await fs.lstat(index.lockPath).catch(() => null);
        if (lock && lock.dev === index.lockDev && lock.ino === index.lockIno && lock.birthtimeMs === index.lockBirthMs) {
            const content = await fs.readFile(index.lockPath);
            if (sha256(content) === index.finalSha256 && await this.allWritten(document.entries)) {
                await fs.rename(index.lockPath, index.indexPath);
                return 'completed';
            }
            const outcome = await this.rollBack(document.entries);
            await fs.rm(index.lockPath, { force: true });
            return outcome;
        }
        return await this.isIndexCommitted(index.states) ? 'completed' : this.rollBack(document.entries);
    }

    private async allWritten(entries: readonly JournalEntry[]): Promise<boolean> {
        for (const entry of entries) {
            if (recordId((await this.store.readActive(entry.path)).record) !== recordId(entry.next)) {
                return false;
            }
        }
        return true;
    }

    private async rollBack(entries: readonly JournalEntry[]): Promise<RecoveryOutcome> {
        for (const entry of entries) {
            const current = await this.store.readActive(entry.path);
            if (!current.isNewerVersion && recordId(current.record) === recordId(entry.next)) {
                await this.store.writeActive(entry.path, entry.previous);
            }
        }
        return 'rolled back';
    }

    private async isIndexCommitted(states: readonly { path: string; after: string }[]): Promise<boolean> {
        const grouped = new Map<string, string[]>();
        for (const chunk of chunkPathspecs(states.map(state => state.path))) {
            for (const record of await this.reader.nulRecords(['ls-files', '-s', '-z', '--', ...chunk])) {
                const repoPath = record.slice(record.indexOf('\t') + 1);
                grouped.set(repoPath, [...(grouped.get(repoPath) ?? []), record]);
            }
        }
        return states.every(state => parseIndexEntries(grouped.get(state.path) ?? [], state.path).state === state.after);
    }
}
