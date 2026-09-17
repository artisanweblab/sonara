import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FrontierRecord } from '../types';
import { isErrorCode } from './directory-lock';
import { decodeActive } from './record-codec';

const JOURNAL_VERSION = 1;
const JOURNAL_EXTENSION = '.json';
const HASH_REFERENCE = /[0-9a-f]{64}/g;

export interface JournalEntry {
    path: string;
    previous: FrontierRecord | null;
    next: FrontierRecord | null;
}

export interface JournalIndexState {
    path: string;
    after: string;
}

export interface JournalIndex {
    indexPath: string;
    lockPath: string;
    lockDev: number;
    lockIno: number;
    lockBirthMs: number;
    finalSha256: string;
    states: JournalIndexState[];
}

export interface JournalDocument {
    version: typeof JOURNAL_VERSION;
    pid: number;
    hostname: string;
    identity: string | null;
    createdAt: string;
    entries: JournalEntry[];
    index: JournalIndex | null;
}

export type JournalRead = { status: 'valid'; document: JournalDocument } | { status: 'invalid'; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeRecord(repoPath: string, raw: unknown): FrontierRecord | null | 'invalid' {
    if (raw === null) {
        return null;
    }
    const decoded = decodeActive(repoPath, raw);
    return decoded.status === 'record' ? decoded.record : 'invalid';
}

function decodeIndex(raw: unknown): JournalIndex | null | 'invalid' {
    if (raw === null) {
        return null;
    }
    if (!isObject(raw) || typeof raw.indexPath !== 'string' || typeof raw.lockPath !== 'string' || typeof raw.lockDev !== 'number'
        || typeof raw.lockIno !== 'number' || typeof raw.lockBirthMs !== 'number' || typeof raw.finalSha256 !== 'string' || !Array.isArray(raw.states)) {
        return 'invalid';
    }
    const states = raw.states.filter((state): state is JournalIndexState => isObject(state) && typeof state.path === 'string' && typeof state.after === 'string');
    if (states.length !== raw.states.length) {
        return 'invalid';
    }
    return { indexPath: raw.indexPath, lockPath: raw.lockPath, lockDev: raw.lockDev, lockIno: raw.lockIno, lockBirthMs: raw.lockBirthMs, finalSha256: raw.finalSha256, states };
}

export class MoveJournal {
    private readonly root: string;

    constructor(reviewRoot: string) {
        this.root = path.join(reviewRoot, 'journal');
    }

    create(entries: JournalEntry[], identity: string | null, index: JournalIndex | null): JournalDocument {
        return { version: JOURNAL_VERSION, pid: process.pid, hostname: os.hostname(), identity, createdAt: new Date().toISOString(), entries, index };
    }

    async write(document: JournalDocument): Promise<string> {
        await fs.mkdir(this.root, { recursive: true });
        const name = `${Date.now()}-${process.pid}-${randomBytes(6).toString('hex')}${JOURNAL_EXTENSION}`;
        const target = path.join(this.root, name);
        const temporary = path.join(this.root, `.${name}.tmp`);
        const handle = await fs.open(temporary, 'wx');
        try {
            await handle.writeFile(JSON.stringify(document), 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.rename(temporary, target);
        return target;
    }

    async list(): Promise<string[]> {
        try {
            return (await fs.readdir(this.root)).filter(name => name.endsWith(JOURNAL_EXTENSION) && !name.startsWith('.')).sort().map(name => path.join(this.root, name));
        } catch (error) {
            if (isErrorCode(error, 'ENOENT')) {
                return [];
            }
            throw error;
        }
    }

    async read(file: string): Promise<JournalRead> {
        let raw: unknown;
        try {
            raw = JSON.parse(await fs.readFile(file, 'utf8'));
        } catch (error) {
            return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
        }
        if (!isObject(raw) || raw.version !== JOURNAL_VERSION || typeof raw.pid !== 'number' || typeof raw.hostname !== 'string' || !Array.isArray(raw.entries)) {
            return { status: 'invalid', reason: 'unknown journal format' };
        }
        const entries: JournalEntry[] = [];
        for (const entry of raw.entries) {
            if (!isObject(entry) || typeof entry.path !== 'string') {
                return { status: 'invalid', reason: 'malformed entry' };
            }
            const previous = decodeRecord(entry.path, entry.previous);
            const next = decodeRecord(entry.path, entry.next);
            if (previous === 'invalid' || next === 'invalid') {
                return { status: 'invalid', reason: `malformed record for ${entry.path}` };
            }
            entries.push({ path: entry.path, previous, next });
        }
        const index = decodeIndex(raw.index ?? null);
        if (index === 'invalid') {
            return { status: 'invalid', reason: 'malformed index section' };
        }
        const identity = typeof raw.identity === 'string' ? raw.identity : null;
        return { status: 'valid', document: { version: JOURNAL_VERSION, pid: raw.pid, hostname: raw.hostname, identity, createdAt: String(raw.createdAt), entries, index } };
    }

    async remove(file: string): Promise<void> {
        await fs.rm(file, { force: true });
    }

    async setAside(file: string): Promise<string> {
        const target = `${file}.unrecoverable`;
        await fs.rename(file, target);
        return target;
    }

    async referencedHashes(): Promise<Set<string>> {
        const hashes = new Set<string>();
        let names: string[];
        try {
            names = await fs.readdir(this.root);
        } catch (error) {
            if (isErrorCode(error, 'ENOENT')) {
                return hashes;
            }
            throw error;
        }
        for (const name of names) {
            const text = await fs.readFile(path.join(this.root, name), 'latin1');
            for (const match of text.match(HASH_REFERENCE) ?? []) {
                hashes.add(match);
            }
        }
        return hashes;
    }
}
