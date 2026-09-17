import type { FileSnapshot, GitSide } from '../git/content-loader';
import type { IndexTarget } from '../git/index-target';
import { recordId, staleReason } from '../model/file-generation';
import { MISSING_MODE, contentHash, sha256 } from '../model/file-state';
import { HASH_VALUES, SEGMENT_VALUES, Segments } from '../model/ladder-values';
import { STAGED_RANK, frontiersFromLayers } from '../model/level-ladder';
import { toBuffer, toSegments } from '../model/segment-codec';
import { StateLayers, WHOLE_FILE_HUNK, planStateMove } from '../model/state-move-planner';
import { textBlobReferences } from '../store/record-codec';
import { FileGeneration, FrontierRecord, RangeHunk, ReviewAtomState, reviewLevelRank } from '../types';
import { FileStack, buildFileStack, layerHash } from './file-stack';
import { BlobContents, EncodedRecord, encodeOpaque, encodeText } from './frontier-encoding';
import { gitAtoms, levelChanges, stackAtoms } from './level-changes';
import {
    MoveCommand,
    MoveOutcome,
    conflictMessage,
    dependentMessage,
    noChangeMessage,
    refused,
    stale,
    waitingMessage,
} from './move-outcome';

export interface RecordPairView {
    active: FrontierRecord | null;
    hasLegacy: boolean;
    isNewerVersion: boolean;
}

export interface MovePlanInput {
    command: MoveCommand;
    head: string;
    pair: RecordPairView;
    snapshot: FileSnapshot;
    blobs: BlobContents;
}

export interface PlannedChange {
    indexTarget: IndexTarget | null;
    isRecordChanged: boolean;
    record: FrontierRecord | null;
    newBlobs: Buffer[];
    generation: FileGeneration;
    atoms: ReviewAtomState[] | null;
    changeCount: number;
}

export type MovePlan =
    | { kind: 'outcome'; outcome: MoveOutcome }
    | { kind: 'change'; change: PlannedChange };

interface StagedVersion {
    target: IndexTarget;
    content: Buffer | null;
}

function outcome(result: MoveOutcome): MovePlan {
    return { kind: 'outcome', outcome: result };
}

function fromSide(side: GitSide, mode: string, hash: string): StagedVersion | null {
    if (side.mode === MISSING_MODE || contentHash(side.content) !== hash) {
        return null;
    }
    const content = side.content ?? Buffer.alloc(0);
    return side.objectId && side.mode === mode
        ? { target: { kind: 'object', mode, objectId: side.objectId }, content }
        : { target: { kind: 'blob', mode, content }, content };
}

function stagedVersion(stack: FileStack, layers: StateLayers): StagedVersion | null {
    const mode = layers.modes[STAGED_RANK];
    if (mode === MISSING_MODE) {
        return { target: { kind: 'remove' }, content: null };
    }
    const { head, index, worktree } = stack.snapshot;
    if (stack.kind === 'text') {
        const content = toBuffer(layers.content[STAGED_RANK]);
        return fromSide(head, mode, contentHash(content)) ?? { target: { kind: 'blob', mode, content }, content };
    }
    const hash = layerHash(layers.content[STAGED_RANK]);
    const worktreeSide: GitSide = { mode: worktree.mode, objectId: null, content: worktree.content };
    for (const side of [head, index, worktreeSide]) {
        const version = fromSide(side, mode, hash);
        if (version) {
            return version;
        }
    }
    return null;
}

function encode(repoPath: string, head: string, stack: FileStack, layers: StateLayers): EncodedRecord {
    const modes = frontiersFromLayers(stack.snapshot.head.mode, layers.modes, HASH_VALUES);
    if (stack.kind === 'opaque') {
        const content = frontiersFromLayers(contentHash(stack.snapshot.head.content), layers.content.map(layerHash), HASH_VALUES);
        return encodeOpaque(repoPath, head, { content, modes });
    }
    const content = frontiersFromLayers<Segments>(toSegments(stack.snapshot.head.content), layers.content, SEGMENT_VALUES);
    return encodeText(repoPath, head, { content, modes });
}

function atomsAfterRecordMove(input: MovePlanInput, record: FrontierRecord | null, blobs: Buffer[]): ReviewAtomState[] {
    const file = input.command.file;
    if (!record) {
        return gitAtoms(file);
    }
    const contents = new Map(input.blobs);
    blobs.forEach(blob => contents.set(sha256(blob), blob));
    return stackAtoms(file.path, buildFileStack(file.kind, input.head, record, input.snapshot, contents));
}

function finish(input: MovePlanInput, stack: FileStack, record: FrontierRecord | null, layers: StateLayers, changeCount: number): MovePlan {
    const { file, source, target } = input.command;
    const isToStaged = reviewLevelRank(target) === STAGED_RANK;
    const writesIndex = isToStaged || reviewLevelRank(source) === STAGED_RANK;
    const encoded: EncodedRecord = isToStaged ? { record, blobs: [] } : encode(file.path, input.command.generation.head, stack, layers);
    const nextId = recordId(encoded.record);
    const isRecordChanged = nextId !== recordId(record);
    const isIndexChanged = writesIndex
        && (layers.modes[STAGED_RANK] !== stack.modes[STAGED_RANK] || layers.content[STAGED_RANK].join('') !== stack.content[STAGED_RANK].join(''));
    if (!isRecordChanged && !isIndexChanged) {
        return outcome(refused(noChangeMessage(file.path, target)));
    }
    const staged = isIndexChanged ? stagedVersion(stack, layers) : null;
    if (isIndexChanged && !staged) {
        return outcome(refused(`${file.path}: the content for this level is no longer available, so it cannot be staged.`));
    }
    const known = new Set(record ? textBlobReferences(record) : []);
    const newBlobs = isRecordChanged ? encoded.blobs.filter(blob => !known.has(sha256(blob))) : [];
    const nextRecord = isRecordChanged ? encoded.record : record;
    return {
        kind: 'change',
        change: {
            indexTarget: staged?.target ?? null,
            isRecordChanged,
            record: nextRecord,
            newBlobs,
            generation: { ...stack.generation, record: nextId },
            atoms: staged ? null : atomsAfterRecordMove(input, nextRecord, encoded.blobs),
            changeCount,
        },
    };
}

export function planMove(input: MovePlanInput): MovePlan {
    const { command, head, pair } = input;
    const { file, source, generation } = command;
    if (head !== generation.head) {
        return outcome(stale('HEAD changed'));
    }
    if (pair.isNewerVersion) {
        return outcome(refused(`${file.path}: its review levels were written by a newer version of Sonara. Update or reload this window first.`));
    }
    const active = pair.active;
    if (pair.hasLegacy || (active && active.baseHead !== head)) {
        return outcome(refused(waitingMessage(file.path)));
    }
    const record = active && active.kind === file.kind ? active : null;
    const stack = buildFileStack(file.kind, head, record, input.snapshot, input.blobs);
    const reason = staleReason(generation, stack.generation);
    if (reason) {
        return outcome(stale(reason));
    }
    const changes = levelChanges(file.path, stack, source);
    const selected = command.changeIds ? changes.filter(change => command.changeIds?.has(change.id)) : changes;
    if (selected.length === 0) {
        return outcome(refused(command.changeIds
            ? `${file.path}: the selected change is no longer on the ${source} level. The diff is being refreshed.`
            : `${file.path}: there are no changes on the ${source} level.`));
    }
    const sourceRank = reviewLevelRank(source);
    const hunks = stack.kind === 'opaque'
        ? layerHash(stack.content[sourceRank]) !== layerHash(stack.content[sourceRank + 1]) ? [WHOLE_FILE_HUNK] : []
        : selected.map(change => change.range).filter((range): range is RangeHunk => range !== null);
    const isModeIncluded = stack.kind === 'opaque' || selected.some(change => change.range === null);
    const planned = planStateMove(stack.content, stack.modes, { source, target: command.target, hunks, isModeIncluded, isCarryAllowed: stack.kind === 'text' }, stack.isEmpty);
    if (planned.kind === 'conflict') {
        return outcome(refused(conflictMessage(file.path, planned.level)));
    }
    if (planned.kind === 'dependent') {
        return outcome(refused(dependentMessage(file.path, planned.needs)));
    }
    return finish(input, stack, record, planned.layers, selected.length);
}
