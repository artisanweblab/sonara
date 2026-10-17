import type { FileSnapshot } from '../git/content-loader';
import { recordId } from '../model/file-generation';
import { EMPTY_CONTENT_HASH, contentHash } from '../model/file-state';
import { HASH_VALUES, SEGMENT_VALUES, Segments } from '../model/ladder-values';
import { buildStack, frontiersFromLayers } from '../model/level-ladder';
import { toSegments } from '../model/segment-codec';
import { EmptyLayer, StateLayers, normalizeDisplayModes } from '../model/state-move-planner';
import { binaryCopyReferences } from '../store/record-codec';
import { FileGeneration, FrontierKind, FrontierRecord, ScannedFileKind } from '../types';
import { BlobContents, EncodedRecord, encodeOpaque, encodeText, opaqueFrontiers, textFrontiersFromBlobs } from './frontier-encoding';

export const MAX_BINARY_COPY_BYTES = 50 * 1024 * 1024;

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

export function sideBytes(snapshot: FileSnapshot, hash: string): Buffer | undefined {
    for (const side of [snapshot.worktree, snapshot.index, snapshot.head]) {
        if (side.content && contentHash(side.content) === hash) {
            return side.content;
        }
    }
    return undefined;
}

function binaryCopies(snapshot: FileSnapshot, hashes: readonly string[]): Buffer[] {
    return Array.from(new Set(hashes))
        .map(hash => sideBytes(snapshot, hash))
        .filter((content): content is Buffer => content !== undefined && content.length > 0 && content.length <= MAX_BINARY_COPY_BYTES);
}

export function encodeStack(repoPath: string, head: string, stack: FileStack, layers: StateLayers): EncodedRecord {
    const modes = frontiersFromLayers(stack.snapshot.head.mode, layers.modes, HASH_VALUES);
    if (stack.kind === 'opaque') {
        const content = frontiersFromLayers(contentHash(stack.snapshot.head.content), layers.content.map(layerHash), HASH_VALUES);
        const encoded = encodeOpaque(repoPath, head, { content, modes });
        return { record: encoded.record, blobs: encoded.record ? binaryCopies(stack.snapshot, binaryCopyReferences(encoded.record)) : [] };
    }
    const content = frontiersFromLayers<Segments>(toSegments(stack.snapshot.head.content), layers.content, SEGMENT_VALUES);
    return encodeText(repoPath, head, { content, modes });
}
