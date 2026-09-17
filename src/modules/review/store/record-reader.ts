import * as fs from 'fs/promises';
import { DormantRecord, FrontierRecord } from '../types';
import { isErrorCode } from './directory-lock';
import { decodeActive, decodeDormant } from './record-codec';
import { RecordQuarantine } from './record-quarantine';
import { ReviewStorageError } from './review-storage-error';
import { StorageHealth } from './storage-health';

export interface ActiveRead {
    record: FrontierRecord | null;
    legacy: unknown;
    isNewerVersion: boolean;
    exists: boolean;
}

export interface DormantRead {
    record: DormantRecord | null;
    isObsolete: boolean;
    isNewerVersion: boolean;
    exists: boolean;
}

type JsonRead = { kind: 'missing' } | { kind: 'parsed'; raw: unknown } | { kind: 'unreadable'; reason: string };

export class RecordReader {
    constructor(
        private readonly health: StorageHealth,
        private readonly quarantine: RecordQuarantine,
        private readonly isReadOnly: boolean = false,
    ) {}

    async readActive(repoPath: string, recordFile: string): Promise<ActiveRead> {
        const json = await this.readJson(recordFile);
        const missing: ActiveRead = { record: null, legacy: null, isNewerVersion: false, exists: false };
        if (json.kind === 'missing') {
            this.health.recovered(recordFile);
            return missing;
        }
        if (json.kind === 'unreadable') {
            return await this.isolate(recordFile, json.reason) ? missing : { ...missing, exists: true };
        }
        const decoded = decodeActive(repoPath, json.raw);
        if (decoded.status === 'invalid') {
            return await this.isolate(recordFile, decoded.reason) ? missing : { ...missing, exists: true };
        }
        if (decoded.status === 'newer') {
            this.reportNewer(recordFile, decoded.version);
            return { ...missing, isNewerVersion: true, exists: true };
        }
        this.health.recovered(recordFile);
        return {
            record: decoded.status === 'record' ? decoded.record : null,
            legacy: decoded.status === 'legacy' ? decoded.raw : null,
            isNewerVersion: false,
            exists: true,
        };
    }

    async readDormant(repoPath: string, recordFile: string): Promise<DormantRead> {
        const json = await this.readJson(recordFile);
        const missing: DormantRead = { record: null, isObsolete: false, isNewerVersion: false, exists: false };
        if (json.kind === 'missing') {
            this.health.recovered(recordFile);
            return missing;
        }
        if (json.kind === 'unreadable') {
            return await this.isolate(recordFile, json.reason) ? missing : { ...missing, exists: true };
        }
        const decoded = decodeDormant(repoPath, json.raw);
        if (decoded.status === 'invalid') {
            return await this.isolate(recordFile, decoded.reason) ? missing : { ...missing, exists: true };
        }
        if (decoded.status === 'newer') {
            this.reportNewer(recordFile, decoded.version);
            return { ...missing, isNewerVersion: true, exists: true };
        }
        this.health.recovered(recordFile);
        return { record: decoded.status === 'dormant' ? decoded.record : null, isObsolete: decoded.status === 'obsolete', isNewerVersion: false, exists: true };
    }

    private reportNewer(recordFile: string, version: number): void {
        if (!this.health.isUnhealthy(recordFile)) {
            this.health.report({
                kind: 'record-newer-version',
                location: recordFile,
                reason: `record version ${version} was written by a newer Sonara`,
                quarantinedTo: null,
            });
        }
    }

    private async isolate(recordFile: string, reason: string): Promise<boolean> {
        if (this.isReadOnly) {
            this.health.report({ kind: 'record-unreadable', location: recordFile, reason, quarantinedTo: null });
            return true;
        }
        const result = await this.quarantine.isolate(recordFile);
        if (result.status === 'gone') {
            return true;
        }
        this.health.report({ kind: 'record-unreadable', location: recordFile, reason, quarantinedTo: result.status === 'isolated' ? result.target : null });
        if (result.status === 'failed') {
            throw new ReviewStorageError('record-unreadable', `Sonara Review: the review record ${recordFile} is unreadable (${reason}) and could not be moved to quarantine: ${result.reason}`);
        }
        return true;
    }

    private async readJson(filePath: string): Promise<JsonRead> {
        let text: string;
        try {
            text = await fs.readFile(filePath, 'utf8');
        } catch (error) {
            if (isErrorCode(error, 'ENOENT')) {
                return { kind: 'missing' };
            }
            return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
        }
        try {
            return { kind: 'parsed', raw: JSON.parse(text) as unknown };
        } catch (error) {
            return { kind: 'unreadable', reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
}
