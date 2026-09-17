import { Worker } from 'worker_threads';
import { ComputeResult, ComputeTask } from './compute-tasks';

interface PendingRequest {
    resolve: (results: ComputeResult[]) => void;
    reject: (error: Error) => void;
}

interface WorkerResponse {
    id: number;
    results: ComputeResult[];
}

export class PoolWorker {
    private readonly worker: Worker;
    private readonly pending = new Map<number, PendingRequest>();
    private nextId = 0;
    private isAlive = true;

    constructor(script: string) {
        this.worker = new Worker(script);
        this.worker.on('message', (response: WorkerResponse) => {
            const request = this.pending.get(response.id);
            this.pending.delete(response.id);
            request?.resolve(response.results);
        });
        this.worker.on('error', error => this.fail(error));
        this.worker.on('exit', code => this.fail(new Error(`Sonara Review compute worker exited with code ${code}`)));
    }

    load(): number {
        return this.pending.size;
    }

    alive(): boolean {
        return this.isAlive;
    }

    run(tasks: ComputeTask[]): Promise<ComputeResult[]> {
        if (!this.isAlive) {
            return Promise.reject(new Error('Sonara Review compute worker is not running'));
        }
        const id = this.nextId++;
        return new Promise<ComputeResult[]>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.worker.postMessage({ id, tasks });
            } catch (error) {
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    terminate(): void {
        this.isAlive = false;
        void this.worker.terminate();
    }

    private fail(error: Error): void {
        this.isAlive = false;
        const requests = Array.from(this.pending.values());
        this.pending.clear();
        requests.forEach(request => request.reject(error));
    }
}
