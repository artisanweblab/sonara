import { describeError } from '../../../shared/error-description';
import type { FileSnapshot } from '../git/content-loader';
import type { IndexTarget } from '../git/index-target';
import { buildFileStack } from '../frontiers/file-stack';
import { BlobContents } from '../frontiers/frontier-encoding';
import { FileEvaluation, gitAtoms, scanGeneration, stackAtoms } from '../frontiers/level-changes';
import { MovePlan, MovePlanInput, planMove } from '../frontiers/move-planner';
import { FrontierRecord, ScannedFile } from '../types';

export interface EvaluationInput {
    file: ScannedFile;
    head: string;
    record: FrontierRecord | null;
    snapshot: FileSnapshot;
    blobs: BlobContents;
}

export type ComputeTask =
    | { kind: 'plan'; input: MovePlanInput }
    | { kind: 'evaluate'; input: EvaluationInput };

export type ComputeResult =
    | { kind: 'plan'; plan: MovePlan }
    | { kind: 'evaluate'; evaluation: FileEvaluation }
    | { kind: 'error'; message: string; detail: string };

function toBuffer(value: Uint8Array | null): Buffer | null {
    return value === null ? null : Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function reviveSnapshot(snapshot: FileSnapshot): FileSnapshot {
    return {
        head: { ...snapshot.head, content: toBuffer(snapshot.head.content) },
        index: { ...snapshot.index, content: toBuffer(snapshot.index.content) },
        worktree: { ...snapshot.worktree, content: toBuffer(snapshot.worktree.content) },
    };
}

function reviveBlobs(blobs: BlobContents): BlobContents {
    return new Map(Array.from(blobs, ([hash, content]) => [hash, toBuffer(content) as Buffer]));
}

function reviveTarget(target: IndexTarget | null): IndexTarget | null {
    return target?.kind === 'blob' ? { ...target, content: toBuffer(target.content) as Buffer } : target;
}

export function reviveTask(task: ComputeTask): ComputeTask {
    return task.kind === 'plan'
        ? { kind: 'plan', input: { ...task.input, snapshot: reviveSnapshot(task.input.snapshot), blobs: reviveBlobs(task.input.blobs) } }
        : { kind: 'evaluate', input: { ...task.input, snapshot: reviveSnapshot(task.input.snapshot), blobs: reviveBlobs(task.input.blobs) } };
}

export function reviveResult(result: ComputeResult): ComputeResult {
    if (result.kind !== 'plan' || result.plan.kind !== 'change') {
        return result;
    }
    const change = result.plan.change;
    return {
        kind: 'plan',
        plan: {
            kind: 'change',
            change: { ...change, indexTarget: reviveTarget(change.indexTarget), newBlobs: change.newBlobs.map(blob => toBuffer(blob) as Buffer) },
        },
    };
}

export function taskWeight(task: ComputeTask): number {
    const { snapshot, blobs } = task.input;
    let bytes = (snapshot.head.content?.length ?? 0) + (snapshot.index.content?.length ?? 0) + (snapshot.worktree.content?.length ?? 0);
    blobs.forEach(blob => {
        bytes += blob.length;
    });
    return bytes;
}

export function evaluate(input: EvaluationInput): FileEvaluation {
    const { file, head, record } = input;
    if (file.kind === 'special' || !record) {
        return { atoms: gitAtoms(file), generation: scanGeneration(file, head) };
    }
    const stack = buildFileStack(file.kind, head, record, input.snapshot, input.blobs);
    return { atoms: stackAtoms(file.path, stack), generation: stack.generation };
}

export function executeTask(task: ComputeTask): ComputeResult {
    try {
        return task.kind === 'plan'
            ? { kind: 'plan', plan: planMove(task.input) }
            : { kind: 'evaluate', evaluation: evaluate(task.input) };
    } catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : String(error), detail: describeError(error) };
    }
}
