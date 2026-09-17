import * as fs from 'fs/promises';
import * as path from 'path';
import { mapLimit } from '../model/map-limit';
import { MoveJournal } from './move-journal';
import { RECORD_EXTENSION, UnreadableDirectory, listRecordFiles } from './record-files';
import { blobReferenceLabel, decodeActive, decodeDormant, legacyBlobReferences, textBlobReferenceEntries } from './record-codec';
import { RecordQuarantine } from './record-quarantine';
import { ReviewBlobStore, isBlobName } from './review-blob-store';

const READ_CONCURRENCY = 32;

export interface DanglingReference {
    repoPath: string;
    where: string;
    hash: string;
}

export interface StorageReport {
    reviewRoot: string;
    records: number;
    dormantRecords: number;
    unreadableRecords: string[];
    unreadableDirectories: UnreadableDirectory[];
    blobs: number;
    foreignBlobFiles: number;
    referencedBlobs: number;
    dangling: DanglingReference[];
    orphanBlobs: number;
    quarantinedRecords: number;
    journals: number;
}

interface RecordScan {
    count: number;
    unreadable: string[];
    references: DanglingReference[];
    unreadableDirectories: UnreadableDirectory[];
}

export class StorageInspector {
    private readonly blobs: ReviewBlobStore;
    private readonly journal: MoveJournal;
    private readonly quarantine: RecordQuarantine;

    constructor(private readonly reviewRoot: string) {
        this.blobs = new ReviewBlobStore(reviewRoot);
        this.journal = new MoveJournal(reviewRoot);
        this.quarantine = new RecordQuarantine(reviewRoot);
    }

    async inspect(): Promise<StorageReport> {
        const active = await this.scan('files', false);
        const dormant = await this.scan('dormant', true);
        const listed = await this.blobs.list();
        const present = new Set(listed.filter(isBlobName));
        const references = [...active.references, ...dormant.references];
        const protectedHashes = new Set([...(await this.quarantine.referencedHashes()), ...(await this.journal.referencedHashes())]);
        const referenced = new Set([...references.map(reference => reference.hash), ...protectedHashes]);
        return {
            reviewRoot: this.reviewRoot,
            records: active.count,
            dormantRecords: dormant.count,
            unreadableRecords: [...active.unreadable, ...dormant.unreadable],
            unreadableDirectories: [...active.unreadableDirectories, ...dormant.unreadableDirectories],
            blobs: present.size,
            foreignBlobFiles: listed.length - present.size,
            referencedBlobs: Array.from(referenced).filter(hash => present.has(hash)).length,
            dangling: references.filter(reference => !present.has(reference.hash)),
            orphanBlobs: Array.from(present).filter(hash => !referenced.has(hash)).length,
            quarantinedRecords: (await this.quarantine.list()).length,
            journals: (await this.journal.list()).length,
        };
    }

    private async scan(root: 'files' | 'dormant', isDormant: boolean): Promise<RecordScan> {
        const directory = path.join(this.reviewRoot, root);
        const listing = await listRecordFiles(directory);
        const scan: RecordScan = { count: 0, unreadable: [], references: [], unreadableDirectories: listing.unreadable };
        const results = await mapLimit(listing.repoPaths, READ_CONCURRENCY, repoPath => this.readRecord(directory, repoPath, isDormant));
        for (const result of results) {
            scan.count++;
            if ('reason' in result) {
                scan.unreadable.push(`${result.repoPath}: ${result.reason}`);
            } else {
                scan.references.push(...result.references);
            }
        }
        return scan;
    }

    private async readRecord(
        directory: string,
        repoPath: string,
        isDormant: boolean,
    ): Promise<{ repoPath: string; references: DanglingReference[] } | { repoPath: string; reason: string }> {
        const file = path.join(directory, ...repoPath.split('/')) + RECORD_EXTENSION;
        let raw: unknown;
        try {
            raw = JSON.parse(await fs.readFile(file, 'utf8'));
        } catch (error) {
            return { repoPath, reason: error instanceof Error ? error.message : String(error) };
        }
        const decoded = isDormant ? decodeDormant(repoPath, raw) : decodeActive(repoPath, raw);
        if (decoded.status === 'invalid') {
            return { repoPath, reason: decoded.reason };
        }
        if (decoded.status === 'newer') {
            return { repoPath, reason: `written by a newer Sonara (record version ${decoded.version})` };
        }
        if (decoded.status === 'legacy') {
            return { repoPath, references: legacyBlobReferences(decoded.raw).map(hash => ({ repoPath, where: 'an earlier format', hash })) };
        }
        if (decoded.status !== 'record' && decoded.status !== 'dormant') {
            return { repoPath, references: [] };
        }
        const where = isDormant ? 'the stashed copy of ' : '';
        return {
            repoPath,
            references: textBlobReferenceEntries(decoded.record).map(reference => ({
                repoPath,
                where: `${where}${blobReferenceLabel(reference.slot)}`,
                hash: reference.hash,
            })),
        };
    }
}
