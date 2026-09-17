import { createHash } from 'crypto';

export const MISSING_MODE = 'missing';
export const REGULAR_MODE = '100644';
export const EXECUTABLE_MODE = '100755';
export const SYMLINK_MODE = '120000';
export const GITLINK_MODE = '160000';
export const UNMERGED_STATE = 'unmerged';
export const UNREADABLE_STATE = 'unreadable';

const MODE_PATTERN = /^(1[0-7]{5}|missing)$/;

export const OBJECT_ID_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function sha256(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex');
}

export const EMPTY_CONTENT_HASH = sha256(Buffer.alloc(0));

export interface StatLike {
    isSymbolicLink(): boolean;
    isFile(): boolean;
    mode: number;
}

export function isValidMode(value: unknown): value is string {
    return typeof value === 'string' && MODE_PATTERN.test(value);
}

export function contentHash(content: Buffer | null): string {
    return content === null ? EMPTY_CONTENT_HASH : sha256(content);
}

export function fileStateId(mode: string, content: Buffer | null): string {
    return mode === MISSING_MODE ? MISSING_MODE : `${mode}:${contentHash(content)}`;
}

export function indexStateId(mode: string, objectId: string): string {
    return `${mode}:${objectId}`;
}

export function modeOfState(state: string): string | null {
    const separator = state.indexOf(':');
    const mode = separator < 0 ? state : state.slice(0, separator);
    return isValidMode(mode) ? mode : null;
}

export function worktreeModeOf(stat: StatLike | null, indexMode: string | null, trustExecutableBit: boolean): string {
    if (!stat) {
        return MISSING_MODE;
    }
    if (stat.isSymbolicLink()) {
        return SYMLINK_MODE;
    }
    if (!stat.isFile()) {
        return MISSING_MODE;
    }
    if (trustExecutableBit) {
        return (stat.mode & 0o111) !== 0 ? EXECUTABLE_MODE : REGULAR_MODE;
    }
    return indexMode === EXECUTABLE_MODE ? EXECUTABLE_MODE : REGULAR_MODE;
}

export function describeModeChange(before: string, after: string): string {
    if (before === MISSING_MODE) {
        return `file created (${describeMode(after)})`;
    }
    if (after === MISSING_MODE) {
        return 'file deleted';
    }
    return `${describeMode(before)} -> ${describeMode(after)}`;
}

function describeMode(mode: string): string {
    switch (mode) {
        case REGULAR_MODE:
            return 'regular file';
        case EXECUTABLE_MODE:
            return 'executable file';
        case SYMLINK_MODE:
            return 'symbolic link';
        default:
            return `mode ${mode}`;
    }
}
