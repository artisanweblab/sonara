import { EMPTY_CONTENT_HASH, MISSING_MODE, OBJECT_ID_PATTERN, isValidMode } from '../model/file-state';
import { DormantRecord, FrontierKind, FrontierRecord, STORED_REVIEW_LEVELS, StoredFrontierState, StoredFrontiers, StoredReviewLevel } from '../types';

export const RECORD_VERSION = 5;

const LEVEL_NAME_VERSION = 4;
const PREVIOUS_VERSION = 3;
export const EARLIER_LEVEL_KEYS: Readonly<Record<StoredReviewLevel, string>> = { queued: 'seen', read: 'looked', verified: 'verified' };
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PREVIOUS_MISSING = 'missing';

export type ActiveDecoding =
    | { status: 'record'; record: FrontierRecord }
    | { status: 'legacy'; raw: unknown }
    | { status: 'empty' }
    | { status: 'newer'; version: number }
    | { status: 'invalid'; reason: string };

export type DormantDecoding =
    | { status: 'dormant'; record: DormantRecord }
    | { status: 'obsolete' }
    | { status: 'newer'; version: number }
    | { status: 'invalid'; reason: string };

type BodyDecoding = { status: 'record'; record: FrontierRecord } | { status: 'empty' } | { status: 'invalid'; reason: string };

type StateDecoding = StoredFrontierState | 'dropped' | 'invalid';

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeState(value: unknown): StateDecoding {
    if (!isObject(value)) {
        return 'invalid';
    }
    const state: StoredFrontierState = {};
    if (value.content !== undefined) {
        if (typeof value.content !== 'string' || !HASH_PATTERN.test(value.content)) {
            return 'invalid';
        }
        state.content = value.content;
    }
    if (value.mode !== undefined) {
        if (!isValidMode(value.mode)) {
            return 'invalid';
        }
        state.mode = value.mode;
    }
    return state.content === undefined && state.mode === undefined ? 'invalid' : state;
}

function decodePreviousState(kind: FrontierKind, value: unknown, isBase: boolean): StateDecoding {
    if (typeof value !== 'string') {
        return 'invalid';
    }
    if (kind === 'opaque' && value === PREVIOUS_MISSING) {
        return { content: EMPTY_CONTENT_HASH, mode: MISSING_MODE };
    }
    if (!HASH_PATTERN.test(value)) {
        return 'invalid';
    }
    return kind === 'text' && value === EMPTY_CONTENT_HASH && !isBase ? 'dropped' : { content: value };
}

function decodeBody(repoPath: string, raw: Record<string, unknown>, version: number): BodyDecoding {
    const kind = raw.kind;
    if (kind !== 'text' && kind !== 'opaque') {
        return { status: 'invalid', reason: 'unknown kind' };
    }
    if (typeof raw.baseHead !== 'string' || !OBJECT_ID_PATTERN.test(raw.baseHead)) {
        return { status: 'invalid', reason: 'baseHead is not a commit id' };
    }
    if (!isObject(raw.frontiers)) {
        return { status: 'invalid', reason: 'frontiers is not an object' };
    }
    const decode = (value: unknown, isBase: boolean): StateDecoding =>
        version === PREVIOUS_VERSION ? decodePreviousState(kind, value, isBase) : decodeState(value);
    const frontiers: StoredFrontiers = {};
    for (const level of STORED_REVIEW_LEVELS) {
        const value = raw.frontiers[version === RECORD_VERSION ? level : EARLIER_LEVEL_KEYS[level]];
        if (value === undefined) {
            continue;
        }
        const state = decode(value, false);
        if (state === 'invalid') {
            return { status: 'invalid', reason: `frontier ${level} is malformed` };
        }
        if (state !== 'dropped') {
            frontiers[level] = state;
        }
    }
    const record: FrontierRecord = { version: RECORD_VERSION, path: repoPath, baseHead: raw.baseHead, kind, frontiers };
    if (raw.indexBase !== undefined) {
        const base = decode(raw.indexBase, true);
        if (base === 'invalid') {
            return { status: 'invalid', reason: 'indexBase is malformed' };
        }
        if (base !== 'dropped') {
            record.indexBase = base;
        }
    }
    if (Object.keys(frontiers).length === 0) {
        return version === PREVIOUS_VERSION ? { status: 'empty' } : { status: 'invalid', reason: 'no frontiers' };
    }
    return { status: 'record', record };
}

export function decodeActive(repoPath: string, raw: unknown): ActiveDecoding {
    if (!isObject(raw)) {
        return { status: 'invalid', reason: 'not a JSON object' };
    }
    if (raw.version === 1 || raw.version === 2) {
        return { status: 'legacy', raw };
    }
    if (isNewerVersion(raw.version)) {
        return { status: 'newer', version: raw.version };
    }
    if (raw.version !== RECORD_VERSION && raw.version !== LEVEL_NAME_VERSION && raw.version !== PREVIOUS_VERSION) {
        return { status: 'invalid', reason: `unknown version ${String(raw.version)}` };
    }
    return decodeBody(repoPath, raw, raw.version);
}

function isNewerVersion(version: unknown): version is number {
    return typeof version === 'number' && Number.isInteger(version) && version > RECORD_VERSION;
}

export function decodeDormant(repoPath: string, raw: unknown): DormantDecoding {
    if (!isObject(raw)) {
        return { status: 'invalid', reason: 'not a JSON object' };
    }
    if (raw.version === PREVIOUS_VERSION) {
        return { status: 'obsolete' };
    }
    if (isNewerVersion(raw.version)) {
        return { status: 'newer', version: raw.version };
    }
    if (raw.version !== RECORD_VERSION && raw.version !== LEVEL_NAME_VERSION) {
        return { status: 'invalid', reason: `unknown version ${String(raw.version)}` };
    }
    const body = decodeBody(repoPath, raw, raw.version);
    if (body.status !== 'record') {
        return { status: 'invalid', reason: body.status === 'invalid' ? body.reason : 'no frontiers' };
    }
    if (typeof raw.worktreeState !== 'string' || typeof raw.indexState !== 'string') {
        return { status: 'invalid', reason: 'worktreeState or indexState is missing' };
    }
    if (typeof raw.stashOid !== 'string' || !OBJECT_ID_PATTERN.test(raw.stashOid)) {
        return { status: 'invalid', reason: 'stashOid is not a commit id' };
    }
    return {
        status: 'dormant',
        record: { ...body.record, worktreeState: raw.worktreeState, indexState: raw.indexState, stashOid: raw.stashOid },
    };
}

export function encodeRecord(repoPath: string, record: FrontierRecord): string {
    return JSON.stringify({ ...record, version: RECORD_VERSION, path: repoPath }, null, 2) + '\n';
}

export function textBlobReferences(record: FrontierRecord): string[] {
    if (record.kind !== 'text') {
        return [];
    }
    return [...STORED_REVIEW_LEVELS.map(level => record.frontiers[level]?.content), record.indexBase?.content]
        .filter((hash): hash is string => hash !== undefined);
}

export function legacyBlobReferences(raw: unknown): string[] {
    const layers = isObject(raw) ? raw.layers : null;
    if (!isObject(layers)) {
        return [];
    }
    return Object.values(layers)
        .map(layer => isObject(layer) ? layer.blob : null)
        .filter((blob): blob is string => typeof blob === 'string');
}
