import { GITLINK_MODE } from '../model/file-state';
import { FileChange, Hunk } from '../types';

export interface RawEntry {
    path: string;
    srcMode: string;
    dstMode: string;
    srcOid: string;
    dstOid: string;
    status: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NO_NEWLINE_MARKER = '\\';
const DEV_NULL = '/dev/null';
const SRC_PREFIX = 'a/';
const DST_PREFIX = 'b/';

const C_ESCAPES: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    '"': 0x22,
    '\\': 0x5c,
};

interface QuotedToken {
    value: string;
    rest: string;
}

function readQuoted(text: string): QuotedToken | null {
    if (!text.startsWith('"')) {
        return null;
    }
    const bytes: number[] = [];
    let i = 1;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            return { value: Buffer.from(bytes).toString('utf8'), rest: text.slice(i + 1) };
        }
        if (ch === '\\' && i + 1 < text.length) {
            const next = text[i + 1];
            if (/[0-7]/.test(next)) {
                const octal = text.slice(i + 1, i + 4);
                bytes.push(parseInt(octal, 8));
                i += 4;
                continue;
            }
            bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
            i += 2;
            continue;
        }
        bytes.push(...Buffer.from(ch, 'utf8'));
        i += 1;
    }
    return null;
}

function unquotePath(raw: string): string {
    const quoted = readQuoted(raw);
    return quoted ? quoted.value : raw;
}

function stripPrefix(value: string, prefix: string): string {
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function parseHeaderPath(rest: string): string | null {
    const quotedA = readQuoted(rest);
    if (quotedA) {
        const second = quotedA.rest.trimStart();
        const quotedB = readQuoted(second);
        return stripPrefix(quotedB ? quotedB.value : second, DST_PREFIX);
    }
    if (!rest.startsWith(SRC_PREFIX)) {
        return null;
    }
    const nameLength = (rest.length - SRC_PREFIX.length - 1 - DST_PREFIX.length) / 2;
    if (Number.isInteger(nameLength) && nameLength > 0) {
        const name = rest.slice(SRC_PREFIX.length, SRC_PREFIX.length + nameLength);
        if (rest.slice(SRC_PREFIX.length + nameLength) === ` ${DST_PREFIX}${name}`) {
            return name;
        }
    }
    const quotedB = rest.lastIndexOf(` "${DST_PREFIX}`);
    if (quotedB >= 0) {
        return unquotePath(rest.slice(quotedB + 1)).slice(DST_PREFIX.length);
    }
    const separator = rest.lastIndexOf(` ${DST_PREFIX}`);
    return separator >= 0 ? rest.slice(separator + 1 + DST_PREFIX.length) : null;
}

function parseMarkerPath(raw: string, prefix: string): string | null {
    const value = raw.endsWith('\t') ? raw.slice(0, -1) : raw;
    if (value === DEV_NULL) {
        return null;
    }
    return stripPrefix(unquotePath(value), prefix);
}

function parseRawLine(line: string): RawEntry | null {
    const tab = line.indexOf('\t');
    const fields = (tab < 0 ? '' : line.slice(1, tab)).split(' ');
    if (fields.length < 5) {
        return null;
    }
    const [srcMode, dstMode, srcOid, dstOid, status] = fields;
    return { path: unquotePath(line.slice(tab + 1)), srcMode, dstMode, srcOid, dstOid, status };
}

export class DiffParser {
    private readonly files: FileChange[] = [];
    private readonly raw = new Map<string, RawEntry>();
    private readonly combinedPaths = new Set<string>();
    private current: FileChange | null = null;
    private hunk: Hunk | null = null;
    private lastSide: 'removed' | 'added' | null = null;
    private skipCombined = false;

    push(line: string): void {
        if (this.current === null && line.startsWith('::')) {
            this.combinedPaths.add(unquotePath(line.slice(line.indexOf('\t') + 1)));
            return;
        }
        if (this.current === null && line.startsWith(':')) {
            const entry = parseRawLine(line);
            if (entry && (!this.raw.has(entry.path) || entry.status.startsWith('U'))) {
                this.raw.set(entry.path, entry);
            }
            return;
        }
        if (line.startsWith('diff --git ')) {
            this.startFile(parseHeaderPath(line.slice('diff --git '.length)) ?? '', false);
            return;
        }
        if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
            const rest = line.slice(line.indexOf(' ', 'diff --'.length) + 1);
            this.startFile(unquotePath(rest), true);
            return;
        }
        if (line.startsWith('* Unmerged path ')) {
            this.startFile(unquotePath(line.slice('* Unmerged path '.length)), true);
            this.closeFile();
            return;
        }
        const file = this.current;
        if (!file) {
            return;
        }
        if (this.skipCombined) {
            return;
        }
        if (this.hunk && this.pushHunkLine(line)) {
            return;
        }
        this.pushHeaderLine(file, line);
    }

    finish(): FileChange[] {
        this.closeFile();
        for (const combinedPath of this.combinedPaths) {
            if (!this.files.some(file => file.path === combinedPath)) {
                this.startFile(combinedPath, true);
                this.closeFile();
            }
        }
        return this.files;
    }

    rawEntries(): ReadonlyMap<string, RawEntry> {
        return this.raw;
    }

    private startFile(filePath: string, isUnmerged: boolean): void {
        this.closeFile();
        this.current = {
            path: filePath,
            status: 'modified',
            isBinary: false,
            isSubmodule: false,
            isUnmerged,
            hunks: [],
        };
        this.skipCombined = isUnmerged;
    }

    private closeFile(): void {
        this.closeHunk();
        if (this.current) {
            this.files.push(this.current);
        }
        this.current = null;
        this.skipCombined = false;
    }

    private closeHunk(): void {
        if (this.hunk && this.current) {
            this.current.hunks.push(this.hunk);
        }
        this.hunk = null;
        this.lastSide = null;
    }

    private pushHunkLine(line: string): boolean {
        const hunk = this.hunk;
        if (!hunk) {
            return false;
        }
        const removedDone = hunk.removedLines.length >= hunk.oldLines;
        const addedDone = hunk.addedLines.length >= hunk.newLines;
        if (line.startsWith('-') && !removedDone) {
            hunk.removedLines.push(line.slice(1));
            this.lastSide = 'removed';
            return true;
        }
        if (line.startsWith('+') && !addedDone) {
            hunk.addedLines.push(line.slice(1));
            this.lastSide = 'added';
            return true;
        }
        if (line.startsWith(' ') && !(removedDone && addedDone)) {
            hunk.removedLines.push(line.slice(1));
            hunk.addedLines.push(line.slice(1));
            this.lastSide = null;
            return true;
        }
        if (line.startsWith(NO_NEWLINE_MARKER)) {
            if (this.lastSide === 'removed') {
                hunk.removedNoNewlineAtEof = true;
            } else if (this.lastSide === 'added') {
                hunk.addedNoNewlineAtEof = true;
            }
            return true;
        }
        this.closeHunk();
        return false;
    }

    private pushHeaderLine(file: FileChange, line: string): void {
        const header = HUNK_HEADER.exec(line);
        if (header) {
            this.closeHunk();
            this.hunk = {
                oldStart: Number(header[1]),
                oldLines: header[2] === undefined ? 1 : Number(header[2]),
                newStart: Number(header[3]),
                newLines: header[4] === undefined ? 1 : Number(header[4]),
                removedLines: [],
                addedLines: [],
                removedNoNewlineAtEof: false,
                addedNoNewlineAtEof: false,
            };
            return;
        }
        if (line.startsWith('new file mode ')) {
            file.status = 'added';
            file.isSubmodule = file.isSubmodule || line.slice('new file mode '.length).trim() === GITLINK_MODE;
            return;
        }
        if (line.startsWith('deleted file mode ')) {
            file.status = 'deleted';
            file.isSubmodule = file.isSubmodule || line.slice('deleted file mode '.length).trim() === GITLINK_MODE;
            return;
        }
        if (line.startsWith('old mode ')) {
            file.isSubmodule = file.isSubmodule || line.slice('old mode '.length).trim() === GITLINK_MODE;
            return;
        }
        if (line.startsWith('new mode ')) {
            file.isSubmodule = file.isSubmodule || line.slice('new mode '.length).trim() === GITLINK_MODE;
            return;
        }
        if (line.startsWith('index ')) {
            const parts = line.split(' ');
            if (parts.length >= 3 && parts[2] === GITLINK_MODE) {
                file.isSubmodule = true;
            }
            return;
        }
        if (line.startsWith('--- ')) {
            const oldPath = parseMarkerPath(line.slice(4), SRC_PREFIX);
            if (oldPath === null) {
                file.status = 'added';
            } else if (file.status !== 'added') {
                file.path = oldPath;
            }
            return;
        }
        if (line.startsWith('+++ ')) {
            const newPath = parseMarkerPath(line.slice(4), DST_PREFIX);
            if (newPath === null) {
                file.status = 'deleted';
            } else {
                file.path = newPath;
            }
            return;
        }
        if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
            file.isBinary = true;
            return;
        }
        if (line.startsWith('Submodule ')) {
            file.isSubmodule = true;
        }
    }
}
