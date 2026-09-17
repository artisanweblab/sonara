import { Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { isErrorCode } from './directory-lock';

export const RECORD_EXTENSION = '.json';

export interface UnreadableDirectory {
    directory: string;
    reason: string;
}

export interface RecordFileListing {
    repoPaths: string[];
    unreadable: UnreadableDirectory[];
}

export function repoPathOfRecord(root: string, recordFile: string): string {
    return path.relative(root, recordFile).slice(0, -RECORD_EXTENSION.length).split(path.sep).join('/');
}

export async function listRecordFiles(root: string): Promise<RecordFileListing> {
    const repoPaths: string[] = [];
    const unreadable: UnreadableDirectory[] = [];
    const walk = async (directory: string): Promise<void> => {
        let entries: Dirent[];
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
            if (!isErrorCode(error, 'ENOENT')) {
                unreadable.push({ directory, reason: error instanceof Error ? error.message : String(error) });
            }
            return;
        }
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.name.endsWith(RECORD_EXTENSION)) {
                repoPaths.push(repoPathOfRecord(root, full));
            }
        }
    };
    await walk(root);
    return { repoPaths, unreadable };
}
