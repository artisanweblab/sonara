import type { FileSnapshot } from '../git/content-loader';
import { recordId } from '../model/file-generation';
import { EMPTY_CONTENT_HASH, contentHash } from '../model/file-state';
import { HASH_VALUES, SEGMENT_VALUES } from '../model/ladder-values';
import { buildStack } from '../model/level-ladder';
import { toSegments } from '../model/segment-codec';
import { EmptyLayer, normalizeDisplayModes } from '../model/state-move-planner';
import { FileGeneration, FrontierKind, FrontierRecord, ScannedFileKind } from '../types';
import { BlobContents, opaqueFrontiers, textFrontiersFromBlobs } from './frontier-encoding';

export interface FileStack {
    kind: FrontierKind;
    snapshot: FileSnapshot;
    content: (readonly string[])[];
    modes: string[];
    generation: FileGeneration;
    isEmpty: EmptyLayer;
}

export function hashLayer(hash: string): string[] {
    return [`${hash}\n`];
}

export function layerHash(layer: readonly string[]): string {
    return (layer[0] ?? '\n').slice(0, -1);
}

const isEmptyText: EmptyLayer = layer => layer.length === 0;
const isEmptyOpaque: EmptyLayer = layer => layerHash(layer) === EMPTY_CONTENT_HASH;

export function buildFileStack(fileKind: ScannedFileKind, head: string, record: FrontierRecord | null, snapshot: FileSnapshot, blobs: BlobContents): FileStack {
    const kind: FrontierKind = fileKind === 'opaque' ? 'opaque' : 'text';
    const generation: FileGeneration = {
        head,
        worktree: snapshot.worktree.state,
        index: snapshot.index.state,
        record: recordId(record),
    };
    const isFullyStaged = snapshot.index.mode === snapshot.worktree.mode
        && contentHash(snapshot.index.content) === contentHash(snapshot.worktree.content);
    if (kind === 'opaque') {
        const frontiers = opaqueFrontiers(record);
        const hashes = buildStack(
            contentHash(snapshot.head.content),
            contentHash(snapshot.index.content),
            contentHash(snapshot.worktree.content),
            frontiers.content,
            isFullyStaged,
            HASH_VALUES,
        );
        const content = hashes.map(hashLayer);
        const modes = buildStack(snapshot.head.mode, snapshot.index.mode, snapshot.worktree.mode, frontiers.modes, isFullyStaged, HASH_VALUES);
        return { kind, snapshot, content, modes: normalizeDisplayModes(content, modes, snapshot.head.mode, isEmptyOpaque), generation, isEmpty: isEmptyOpaque };
    }
    const frontiers = textFrontiersFromBlobs(record, blobs);
    const content = buildStack(
        toSegments(snapshot.head.content),
        toSegments(snapshot.index.content),
        toSegments(snapshot.worktree.content),
        frontiers.content,
        isFullyStaged,
        SEGMENT_VALUES,
    );
    const modes = buildStack(snapshot.head.mode, snapshot.index.mode, snapshot.worktree.mode, frontiers.modes, isFullyStaged, HASH_VALUES);
    return { kind, snapshot, content, modes: normalizeDisplayModes(content, modes, snapshot.head.mode, isEmptyText), generation, isEmpty: isEmptyText };
}
