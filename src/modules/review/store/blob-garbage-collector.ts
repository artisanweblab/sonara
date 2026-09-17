import { ReviewLogger } from '../logging/review-logger';
import { MoveJournal } from './move-journal';
import { legacyBlobReferences, textBlobReferences } from './record-codec';
import { ReviewBlobStore } from './review-blob-store';
import { ReviewStateStore } from './review-state-store';
import { StorageHealth } from './storage-health';

const COLLECT_DELAY_MS = 15000;

export class BlobGarbageCollector {
    private timer: NodeJS.Timeout | undefined;
    private running = false;
    private disposed = false;

    constructor(
        private readonly blobs: ReviewBlobStore,
        private readonly records: ReviewStateStore,
        private readonly journal: MoveJournal,
        private readonly health: StorageHealth,
        private readonly logger: ReviewLogger,
        private readonly isBusy: () => boolean,
    ) {}

    schedule(): void {
        if (this.disposed) {
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => void this.run(), COLLECT_DELAY_MS);
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer) {
            clearTimeout(this.timer);
        }
    }

    private async run(): Promise<void> {
        this.timer = undefined;
        if (this.disposed) {
            return;
        }
        if (this.running || this.isBusy()) {
            this.logger.info('Blob GC postponed: a scan, move or collection is running');
            this.schedule();
            return;
        }
        this.running = true;
        try {
            await this.health.recheck();
            if (!this.health.isHealthy()) {
                this.logger.info(`Blob GC skipped: review storage problems are open for ${this.health.unhealthyLocations().join(', ')}`);
                return;
            }
            await this.blobs.withCollectionLock(() => this.collect());
        } catch (error) {
            this.logger.error('Blob GC failed, no blob was removed after the failure', error);
        } finally {
            this.running = false;
        }
    }

    private async collect(): Promise<void> {
        const entries = await this.blobs.list();
        if (entries.length === 0) {
            return;
        }
        const referenced = new Set<string>();
        for (const repoPath of await this.records.listStoredPaths()) {
            const active = await this.records.readActive(repoPath);
            [...(active.record ? textBlobReferences(active.record) : []), ...legacyBlobReferences(active.legacy)].forEach(hash => referenced.add(hash));
        }
        for (const repoPath of await this.records.listDormantPaths()) {
            const dormant = await this.records.readDormant(repoPath);
            (dormant.record ? textBlobReferences(dormant.record) : []).forEach(hash => referenced.add(hash));
        }
        (await this.records.referencedByQuarantine()).forEach(hash => referenced.add(hash));
        (await this.journal.referencedHashes()).forEach(hash => referenced.add(hash));
        if (!this.health.isHealthy() || this.disposed) {
            this.logger.info('Blob GC aborted: a review storage problem appeared during the collection');
            return;
        }
        let removed = 0;
        for (const entry of entries) {
            if (!referenced.has(entry)) {
                await this.blobs.remove(entry);
                removed++;
            }
        }
        this.logger.info(`Blob GC: ${entries.length} blobs, ${removed} removed`);
    }
}
