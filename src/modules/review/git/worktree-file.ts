import { Stats } from 'fs';
import * as fs from 'fs/promises';
import { MISSING_MODE, fileStateId, worktreeModeOf } from '../model/file-state';
import { isErrorCode } from '../store/directory-lock';

const STABLE_READ_ATTEMPTS = 5;

export interface WorktreeState {
    mode: string;
    content: Buffer | null;
    state: string;
    stamp: string;
}

export function statStamp(stat: Stats | null): string {
    return stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` : 'missing';
}

async function lstatOrNull(absolutePath: string): Promise<Stats | null> {
    try {
        return await fs.lstat(absolutePath);
    } catch (error) {
        if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'ENOTDIR')) {
            return null;
        }
        throw error;
    }
}

function sameStat(a: Stats | null, b: Stats | null): boolean {
    if (a === null || b === null) {
        return a === b;
    }
    return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode;
}

async function readContent(absolutePath: string, stat: Stats | null): Promise<Buffer | null> {
    try {
        if (stat?.isSymbolicLink()) {
            return Buffer.from(await fs.readlink(absolutePath), 'utf8');
        }
        return stat?.isFile() ? await fs.readFile(absolutePath) : null;
    } catch (error) {
        if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'EINVAL')) {
            return null;
        }
        throw error;
    }
}

export async function readWorktreeState(absolutePath: string, indexMode: string | null, trustExecutableBit: boolean): Promise<WorktreeState> {
    for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt++) {
        const before = await lstatOrNull(absolutePath);
        const content = await readContent(absolutePath, before);
        const after = await lstatOrNull(absolutePath);
        if (!sameStat(before, after)) {
            continue;
        }
        const mode = content === null ? MISSING_MODE : worktreeModeOf(before, indexMode, trustExecutableBit);
        return { mode, content: mode === MISSING_MODE ? null : content, state: fileStateId(mode, content), stamp: statStamp(before) };
    }
    throw new Error(`Sonara Review: ${absolutePath} kept changing while it was read`);
}
