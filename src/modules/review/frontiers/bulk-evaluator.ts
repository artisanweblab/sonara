import { ComputePool } from '../compute/compute-pool';
import { ComputeTask } from '../compute/compute-tasks';
import { GitEntries, SnapshotBatchLoader } from '../git/snapshot-batch-loader';
import { textBlobReferences } from '../store/record-codec';
import { ReviewBlobStore } from '../store/review-blob-store';
import { ReviewStorageError } from '../store/review-storage-error';
import { FrontierRecord, ScannedFile } from '../types';
import { FileEvaluation } from './level-changes';

const CHUNK = 400;

export interface EvaluationItem {
    file: ScannedFile;
    record: FrontierRecord;
}

export type EvaluationOutcome = FileEvaluation | { error: unknown };

export class BulkEvaluator {
    constructor(
        private readonly snapshots: SnapshotBatchLoader,
        private readonly blobs: ReviewBlobStore,
        private readonly pool: ComputePool,
    ) {}

    async evaluate(items: readonly EvaluationItem[], head: string): Promise<Map<string, EvaluationOutcome>> {
        const outcomes = new Map<string, EvaluationOutcome>();
        const entries = await this.snapshots.entries(items.map(item => item.file.path), head);
        for (let start = 0; start < items.length; start += CHUNK) {
            await this.evaluateChunk(items.slice(start, start + CHUNK), head, entries, outcomes);
        }
        return outcomes;
    }

    private async evaluateChunk(items: readonly EvaluationItem[], head: string, entries: GitEntries, outcomes: Map<string, EvaluationOutcome>): Promise<void> {
        const loads = await this.snapshots.load(items.map(item => item.file.path), head, entries);
        const referencesOf = (item: EvaluationItem): string[] => item.file.kind === 'text' ? textBlobReferences(item.record) : [];
        const contents = await this.blobs.readMany(items.flatMap(referencesOf));
        const tasks: ComputeTask[] = [];
        const tasked: EvaluationItem[] = [];
        for (const item of items) {
            const load = loads.get(item.file.path);
            const references = referencesOf(item);
            const failure = references.map(hash => contents.get(hash)).find((content): content is ReviewStorageError => content instanceof ReviewStorageError);
            if (!load || 'error' in load || failure) {
                outcomes.set(item.file.path, { error: failure ?? (load && 'error' in load ? load.error : new Error('the file could not be read')) });
                continue;
            }
            const blobs = new Map(references.map(hash => [hash, contents.get(hash) as Buffer]));
            tasks.push({ kind: 'evaluate', input: { file: item.file, head, record: item.record, snapshot: load.snapshot, blobs } });
            tasked.push(item);
        }
        const results = await this.pool.run(tasks);
        results.forEach((result, position) => {
            const path = tasked[position].file.path;
            if (result.kind === 'evaluate') {
                outcomes.set(path, result.evaluation);
            } else {
                outcomes.set(path, { error: new Error(result.kind === 'error' ? result.message : 'unexpected compute result') });
            }
        });
    }
}
