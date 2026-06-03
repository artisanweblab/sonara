import * as fs from 'fs';
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

    private fileWatcher: fs.FSWatcher | null = null;
    private draft: DraftRecord | null = null;
    private writeChain: Promise<void> = Promise.resolve();

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
            fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
            const line = JSON.stringify(record) + '\n';
            fs.appendFileSync(this.logPath, line, { encoding: 'utf8', flag: 'a' });
            this.onRecordAddedEmitter.fire(record);
            await this.enforceLimitInner();
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
        if (!this.logPath || !fs.existsSync(this.logPath)) {
            return [];
        }

        const content = fs.readFileSync(this.logPath, 'utf8');
        const records: VoiceRecord[] = [];

        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            try {
                records.push(JSON.parse(trimmed) as VoiceRecord);
            } catch {
                // Skip malformed lines
            }
        }

        records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return records;
    }

    async search(query: string): Promise<VoiceRecord[]> {
        const all = await this.list();
        const q = query.toLowerCase();
        return all.filter(r => r.text.toLowerCase().includes(q));
    }

    async clear(): Promise<void> {
        const op = this.writeChain.then(async () => {
            if (!this.logPath || !fs.existsSync(this.logPath)) {
                return;
            }
            const existing = await this.list();
            await atomicWrite(this.logPath, '');
            for (const record of existing) {
                this.onRecordDeletedEmitter.fire(record.id);
            }
        });
        this.writeChain = op.catch(() => undefined);
        return op;
    }

    get recordCount(): number {
        if (!this.logPath || !fs.existsSync(this.logPath)) {
            return 0;
        }
        const content = fs.readFileSync(this.logPath, 'utf8');
        return content.split('\n').filter(l => l.trim()).length;
    }

    // Must only be called from within a writeChain callback (already serialized).
    private async enforceLimitInner(): Promise<void> {
        const config = vscode.workspace.getConfiguration('sonara.voice.log');
        const maxRecords = config.get<number>('maxRecords', 1000);
        const strategy = config.get<string>('onLimitExceeded', 'delete-oldest');

        const records = await this.list(); // newest-first
        if (records.length <= maxRecords) {
            return;
        }

        let toKeep: VoiceRecord[];
        if (strategy === 'delete-oldest') {
            toKeep = records.slice(0, maxRecords);
        } else {
            return;
        }

        const keptIdSet = new Set(toKeep.map(r => r.id));
        const removedRecords = records.filter(r => !keptIdSet.has(r.id));

        await this.writeAll(toKeep.slice().reverse()); // write oldest-first

        for (const removed of removedRecords) {
            this.onRecordDeletedEmitter.fire(removed.id);
        }
    }

    private async writeAll(records: VoiceRecord[]): Promise<void> {
        if (!this.logPath) {
            return;
        }
        // records should be in append order (oldest first)
        const content = records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
        await atomicWrite(this.logPath, content);
    }

    dispose(): void {
        this.fileWatcher?.close();
        this.onRecordAddedEmitter.dispose();
        this.onRecordUpdatedEmitter.dispose();
        this.onRecordDeletedEmitter.dispose();
        this.onDraftChangedEmitter.dispose();
    }
}
