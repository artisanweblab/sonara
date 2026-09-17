import { parentPort } from 'worker_threads';
import { ComputeTask, executeTask, reviveTask } from './compute-tasks';

interface WorkerRequest {
    id: number;
    tasks: ComputeTask[];
}

parentPort?.on('message', (request: WorkerRequest) => {
    parentPort?.postMessage({ id: request.id, results: request.tasks.map(task => executeTask(reviveTask(task))) });
});
