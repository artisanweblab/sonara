import { Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { isErrorCode } from './directory-lock';

const HASH_REFERENCE = /[0-9a-f]{64}/g;

export type QuarantineResult =
    | { status: 'isolated'; target: string }
    | { status: 'gone' }
    | { status: 'failed'; reason: string };

export class RecordQuarantine {
    private readonly root: string;

    constructor(private readonly reviewRoot: string) {
        this.root = path.join(reviewRoot, 'quarantine');
    }

    async isolate(recordFile: string): Promise<QuarantineResult> {
        const relative = path.relative(this.reviewRoot, recordFile);
        const target = path.join(this.root, `${relative}.${new Date().toISOString().replace(/[:.]/g, '-')}`);
        try {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.rename(recordFile, target);
            return { status: 'isolated', target };
        } catch (error) {
            if (isErrorCode(error, 'ENOENT')) {
                return { status: 'gone' };
            }
            return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
    }

    async list(): Promise<string[]> {
        const files: string[] = [];
        const walk = async (dir: string): Promise<void> => {
            let entries: Dirent[];
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch (error) {
                if (isErrorCode(error, 'ENOENT')) {
                    return;
                }
                throw error;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(full);
                } else {
                    files.push(full);
                }
            }
        };
        await walk(this.root);
        return files;
    }

    async referencedHashes(): Promise<Set<string>> {
        const hashes = new Set<string>();
        for (const file of await this.list()) {
            const text = await fs.readFile(file, 'latin1');
            for (const match of text.match(HASH_REFERENCE) ?? []) {
                hashes.add(match);
            }
        }
        return hashes;
    }
}
