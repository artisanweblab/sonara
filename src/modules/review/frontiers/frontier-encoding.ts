import { sha256 } from '../model/file-state';
import { Segments } from '../model/ladder-values';
import { LevelFrontiers, emptyFrontiers, isEmptyFrontiers } from '../model/level-ladder';
import { toBuffer, toSegments } from '../model/segment-codec';
import { RECORD_VERSION } from '../store/record-codec';
import { FrontierKind, FrontierRecord, STORED_REVIEW_LEVELS, StoredFrontierState, StoredFrontiers } from '../types';

export interface EncodedRecord {
    record: FrontierRecord | null;
    blobs: Buffer[];
}

export interface FileFrontiers<T> {
    content: T;
    modes: LevelFrontiers<string>;
}

export type BlobContents = ReadonlyMap<string, Buffer>;

const FRONTIER_KEYS = [...STORED_REVIEW_LEVELS, 'indexBase'] as const;

function frontierModes(record: FrontierRecord | null): LevelFrontiers<string> {
    const modes = emptyFrontiers<string>();
    if (!record) {
        return modes;
    }
    for (const level of STORED_REVIEW_LEVELS) {
        modes[level] = record.frontiers[level]?.mode ?? null;
    }
    modes.indexBase = record.indexBase?.mode ?? null;
    return modes;
}

function storedState(content: string | null, mode: string | null): StoredFrontierState | null {
    const state: StoredFrontierState = {};
    if (content !== null) {
        state.content = content;
    }
    if (mode !== null) {
        state.mode = mode;
    }
    return content === null && mode === null ? null : state;
}

function buildRecord(
    repoPath: string,
    head: string,
    kind: FrontierKind,
    content: (key: keyof LevelFrontiers<string>) => string | null,
    modes: LevelFrontiers<string>,
): FrontierRecord | null {
    const stored: StoredFrontiers = {};
    for (const level of STORED_REVIEW_LEVELS) {
        const state = storedState(content(level), modes[level]);
        if (state) {
            stored[level] = state;
        }
    }
    if (Object.keys(stored).length === 0) {
        return null;
    }
    const record: FrontierRecord = { version: RECORD_VERSION, path: repoPath, baseHead: head, kind, frontiers: stored };
    const base = storedState(content('indexBase'), modes.indexBase);
    if (base) {
        record.indexBase = base;
    }
    return record;
}

export function textFrontiersFromBlobs(record: FrontierRecord | null, blobs: BlobContents): FileFrontiers<LevelFrontiers<Segments>> {
    const content = emptyFrontiers<Segments>();
    if (record?.kind !== 'text') {
        return { content, modes: emptyFrontiers<string>() };
    }
    const segmentsOf = (hash: string | undefined): Segments | null => {
        if (!hash) {
            return null;
        }
        const blob = blobs.get(hash);
        if (!blob) {
            throw new Error(`Sonara Review: accepted version ${hash} was not loaded`);
        }
        return toSegments(blob);
    };
    for (const level of STORED_REVIEW_LEVELS) {
        content[level] = segmentsOf(record.frontiers[level]?.content);
    }
    content.indexBase = segmentsOf(record.indexBase?.content);
    return { content, modes: frontierModes(record) };
}

export function opaqueFrontiers(record: FrontierRecord | null): FileFrontiers<LevelFrontiers<string>> {
    const content = emptyFrontiers<string>();
    if (record?.kind !== 'opaque') {
        return { content, modes: emptyFrontiers<string>() };
    }
    for (const level of STORED_REVIEW_LEVELS) {
        content[level] = record.frontiers[level]?.content ?? null;
    }
    content.indexBase = record.indexBase?.content ?? null;
    return { content, modes: frontierModes(record) };
}

export function encodeText(repoPath: string, head: string, frontiers: FileFrontiers<LevelFrontiers<Segments>>): EncodedRecord {
    if (isEmptyFrontiers(frontiers.content) && isEmptyFrontiers(frontiers.modes)) {
        return { record: null, blobs: [] };
    }
    const hashes: Partial<Record<keyof LevelFrontiers<Segments>, string>> = {};
    const blobs: Buffer[] = [];
    for (const key of FRONTIER_KEYS) {
        const segments = frontiers.content[key];
        if (segments) {
            const content = toBuffer(segments);
            hashes[key] = sha256(content);
            blobs.push(content);
        }
    }
    const record = buildRecord(repoPath, head, 'text', key => hashes[key] ?? null, frontiers.modes);
    return { record, blobs: record ? blobs : [] };
}

export function encodeOpaque(repoPath: string, head: string, frontiers: FileFrontiers<LevelFrontiers<string>>): EncodedRecord {
    if (isEmptyFrontiers(frontiers.content) && isEmptyFrontiers(frontiers.modes)) {
        return { record: null, blobs: [] };
    }
    return { record: buildRecord(repoPath, head, 'opaque', key => frontiers.content[key], frontiers.modes), blobs: [] };
}
