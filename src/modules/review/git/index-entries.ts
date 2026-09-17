import { MISSING_MODE, UNMERGED_STATE, indexStateId } from '../model/file-state';

export interface ParsedIndexEntry {
    mode: string;
    objectId: string | null;
    state: string;
    conflictMode: string | null;
    hasPreservedFlags: boolean;
}

const CONFLICT_STAGE_PREFERENCE = ['2', '3', '1'];

export function parseIndexEntries(records: readonly string[], repoPath: string): ParsedIndexEntry {
    const entries = records
        .map(record => {
            const tab = record.indexOf('\t');
            const fields = record.slice(0, tab).split(' ');
            const tag = /^\d/.test(fields[0]) ? null : fields.shift() ?? null;
            return { tag, mode: fields[0], objectId: fields[1], stage: fields[2], path: record.slice(tab + 1) };
        })
        .filter(entry => entry.path === repoPath);
    const hasPreservedFlags = entries.some(entry => entry.tag !== null && (entry.tag === 'S' || entry.tag !== entry.tag.toUpperCase()));
    if (entries.some(entry => entry.stage !== '0')) {
        const conflict = CONFLICT_STAGE_PREFERENCE.map(stage => entries.find(entry => entry.stage === stage)).find(entry => entry !== undefined);
        return { mode: MISSING_MODE, objectId: null, state: UNMERGED_STATE, conflictMode: conflict?.mode ?? null, hasPreservedFlags };
    }
    const [entry] = entries;
    if (!entry) {
        return { mode: MISSING_MODE, objectId: null, state: MISSING_MODE, conflictMode: null, hasPreservedFlags };
    }
    return { mode: entry.mode, objectId: entry.objectId, state: indexStateId(entry.mode, entry.objectId), conflictMode: null, hasPreservedFlags };
}
