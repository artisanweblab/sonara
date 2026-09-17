import * as os from 'os';
import * as path from 'path';
import { ReviewLogger } from '../logging/review-logger';
import { ComputeResult, ComputeTask, executeTask, reviveResult, taskWeight } from './compute-tasks';
import { PoolWorker } from './pool-worker';

const MAX_WORKERS = 6;
const CHUNK_TASKS = 24;
const CHUNK_BYTES = 8 * 1024 * 1024;
const IDLE_TERMINATE_MS = 60000;
const INLINE_SLICE_MS = 12;
const WORKER_SCRIPT = path.join(__dirname, 'compute-worker.js');

function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

function chunked(tasks: readonly ComputeTask[]): { start: number; tasks: ComputeTask[] }[] {
    const chunks: { start: number; tasks: ComputeTask[] }[] = [];
    let current: ComputeTask[] = [];
    let start = 0;
    let bytes = 0;
    tasks.forEach((task, position) => {
        const weight = taskWeight(task);
        if (current.length > 0 && (current.length >= CHUNK_TASKS || bytes + weight > CHUNK_BYTES)) {
            chunks.push({ start, tasks: current });
            current = [];
            bytes = 0;
            start = position;
        }
        current.push(task);
        bytes += weight;
    });
    if (current.length > 0) {
        chunks.push({ start, tasks: current });
    }
    return chunks;
}

export class ComputePool {
    private workers: PoolWorker[] = [];
    private isInline = false;
    private running = 0;
    private idleTimer: NodeJS.Timeout | undefined;
    private isDisposed = false;
    private readonly size = Math.max(1, Math.min(MAX_WORKERS, os.cpus().length - 1));

    constructor(private readonly logger: ReviewLogger) {}

    async run(tasks: readonly ComputeTask[]): Promise<ComputeResult[]> {
        if (tasks.length === 0) {
            return [];
        }
        this.running++;
        this.clearIdleTimer();
        try {
            const results = new Array<ComputeResult>(tasks.length);
            const running: Promise<void>[] = [];
            for (const chunk of chunked(tasks)) {
                running.push(this.runChunk(chunk.tasks).then(chunkResults => chunkResults.forEach((result, offset) => {
                    results[chunk.start + offset] = result;
                })));
                await yieldToEventLoop();
            }
            await Promise.all(running);
            return results;
        } finally {
            this.running--;
            this.scheduleIdleTermination();
        }
    }

    dispose(): void {
        this.isDisposed = true;
        this.clearIdleTimer();
        this.terminateWorkers();
    }

    private async runChunk(tasks: ComputeTask[]): Promise<ComputeResult[]> {
        const worker = this.pickWorker();
        if (!worker) {
            return this.runInline(tasks);
        }
        try {
            return (await worker.run(tasks)).map(reviveResult);
        } catch (error) {
            this.logger.error('Review compute worker failed, the work continues on the main thread', error);
            return this.runInline(tasks);
        }
    }

    private pickWorker(): PoolWorker | null {
        if (this.isInline || this.isDisposed) {
            return null;
        }
        this.workers = this.workers.filter(worker => worker.alive());
        if (this.workers.length < this.size) {
            try {
                this.workers.push(new PoolWorker(WORKER_SCRIPT));
            } catch (error) {
                this.isInline = true;
                this.logger.error('Review compute workers could not be started, diffs are computed on the main thread', error);
                return null;
            }
        }
        return this.workers.reduce((best, worker) => worker.load() < best.load() ? worker : best);
    }

    private async runInline(tasks: readonly ComputeTask[]): Promise<ComputeResult[]> {
        const results: ComputeResult[] = [];
        let sliceStart = Date.now();
        for (const task of tasks) {
            results.push(executeTask(task));
            if (Date.now() - sliceStart > INLINE_SLICE_MS) {
                await yieldToEventLoop();
                sliceStart = Date.now();
            }
        }
        return results;
    }

    private scheduleIdleTermination(): void {
        if (this.running > 0 || this.workers.length === 0 || this.isDisposed) {
            return;
        }
        this.idleTimer = setTimeout(() => {
            this.idleTimer = undefined;
            if (this.running === 0) {
                this.terminateWorkers();
            }
        }, IDLE_TERMINATE_MS);
        this.idleTimer.unref();
    }

    private clearIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
    }

    private terminateWorkers(): void {
        this.workers.forEach(worker => worker.terminate());
        this.workers = [];
    }
}
