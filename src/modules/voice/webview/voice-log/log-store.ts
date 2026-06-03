import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { atomicWrite } from '../../../../shared/fs-utils';
import { VoiceRecord } from './types';

export type DraftMode = 'recording' | 'live' | 'transcribing';

export interface DraftRecord {
    id: string;
    mode: DraftMode;
    confirmedText: string;
    pendingText: string;
    startedAt: string;
    durationSec: number;
}

export class LogStore implements vscode.Disposable {
    private readonly onRecordAddedEmitter = new vscode.EventEmitter<VoiceRecord>();
    private readonly onRecordUpdatedEmitter = new vscode.EventEmitter<VoiceRecord>();
    private readonly onRecordDeletedEmitter = new vscode.EventEmitter<string>();
    private readonly onDraftChangedEmitter = new vscode.EventEmitter<DraftRecord | null>();

    readonly onRecordAdded = this.onRecordAddedEmitter.event;
    readonly onRecordUpdated = this.onRecordUpdatedEmitter.event;
    readonly onRecordDeleted = this.onRecordDeletedEmitter.event;
    readonly onDraftChanged = this.onDraftChangedEmitter.event;

    private fileWatcher: fsSync.FSWatcher | null = null;
    private draft: DraftRecord | null = null;
    private writeChain: Promise<void> = Promise.resolve();

    // In-memory cache. null means not yet loaded or invalidated.
    private cachedRecords: VoiceRecord[] | null = null;
    // Broken (non-JSON) raw lines preserved across rewrites.
    private cachedBrokenLines: string[] = [];

    constructor(public readonly logPath: string | null) {}

    get currentDraft(): DraftRecord | null {
        return this.draft;
    }

    setDraft(draft: DraftRecord | null): void {
        this.draft = draft;
        this.onDraftChangedEmitter.fire(draft);
    }

    async add(record: VoiceRecord): Promise<void> {
        const op = this.writeChain.then(async () => {
            if (!this.logPath) {
                return;
            }
            await fs.mkdir(path.dirname(this.logPath), { recursive: true });
            const line = JSON.stringify(record) + '\n';
            await fs.appendFile(this.logPath, line, { encoding: 'utf8' });
            // Append to cache if already populated; otherwise leave null so the
            // next list() call re-reads the file.
            if (this.cachedRecords !== null) {
                this.cachedRecords = [record, ...this.cachedRecords];
            }
            this.onRecordAddedEmitter.fire(record);
        });
        this.writeChain = op.catch(() => undefined);
        return op;
    }

    async get(id: string): Promise<VoiceRecord | null> {
        const records = await this.list();
        return records.find(r => r.id === id) ?? null;
    }

    async update(id: string, updates: Partial<VoiceRecord>): Promise<void> {
        const op = this.writeChain.then(async () => {
            const records = await this.list();
            const index = records.findIndex(r => r.id === id);
            if (index === -1) {
                throw new Error(`Record not found: ${id}`);
            }
            records[index] = { ...records[index], ...updates };
            await this.writeAll(records.slice().reverse());
            this.onRecordUpdatedEmitter.fire(records[index]);
        });
        this.writeChain = op.catch(() => undefined);
        return op;
    }

    async delete(id: string): Promise<void> {
        const op = this.writeChain.then(async () => {
            const records = await this.list();
            const filtered = records.filter(r => r.id !== id);
            await this.writeAll(filtered.slice().reverse());
            this.onRecordDeletedEmitter.fire(id);
        });
        this.writeChain = op.catch(() => undefined);
        return op;
    }

    async list(): Promise<VoiceRecord[]> {
        if (this.cachedRecords !== null) {
            return this.cachedRecords;
        }

        if (!this.logPath) {
            this.cachedRecords = [];
            this.cachedBrokenLines = [];
            return this.cachedRecords;
        }

        let content: string;
        try {
            content = await fs.readFile(this.logPath, 'utf8');
        } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                this.cachedRecords = [];
                this.cachedBrokenLines = [];
                return this.cachedRecords;
            }
            throw err;
        }

        const records: VoiceRecord[] = [];
        const brokenLines: string[] = [];

        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            try {
                records.push(JSON.parse(trimmed) as VoiceRecord);
            } catch {
                brokenLines.push(line);
            }
        }

        records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        this.cachedRecords = records;
        this.cachedBrokenLines = brokenLines;
        return this.cachedRecords;
    }

    async search(query: string): Promise<VoiceRecord[]> {
        const all = await this.list();
        const q = query.toLowerCase();
        return all.filter(r => r.text.toLowerCase().includes(q));
    }

    async clear(): Promise<void> {
        const op = this.writeChain.then(async () => {
            if (!this.logPath) {
                return;
            }
            let existing: VoiceRecord[] = [];
            try {
                existing = await this.list();
            } catch {
                // best-effort: fire events for what we know
            }
            this.invalidateCache();
            await atomicWrite(this.logPath, '');
            for (const record of existing) {
                this.onRecordDeletedEmitter.fire(record.id);
            }
        });
        this.writeChain = op.catch(() => undefined);
        return op;
    }

    // Returns the cached count synchronously. Returns 0 if cache is not yet
    // populated (status bar will refresh on the next record event).
    get recordCount(): number {
        return this.cachedRecords?.length ?? 0;
    }

    private async writeAll(records: VoiceRecord[]): Promise<void> {
        if (!this.logPath) {
            return;
        }
        // records should be in append order (oldest first)
        // Preserve broken lines by appending them after the valid records so
        // they are never silently lost on a rewrite.
        const validContent = records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
        const brokenContent = this.cachedBrokenLines.length
            ? this.cachedBrokenLines.join('\n') + '\n'
            : '';
        await atomicWrite(this.logPath, validContent + brokenContent);
        // Update cache: newest-first sorted view of the written records.
        const sorted = records.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        this.cachedRecords = sorted;
        // cachedBrokenLines stays as-is (they are still present in the file)
    }

    private invalidateCache(): void {
        this.cachedRecords = null;
        this.cachedBrokenLines = [];
    }

    dispose(): void {
        this.fileWatcher?.close();
        this.onRecordAddedEmitter.dispose();
        this.onRecordUpdatedEmitter.dispose();
        this.onRecordDeletedEmitter.dispose();
        this.onDraftChangedEmitter.dispose();
    }
}
