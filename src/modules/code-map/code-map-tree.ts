import { FileStats } from './code-map-scanner';

export type CodeMapSort = 'lines' | 'name';

export interface CodeMapTotals {
    files: number;
    lines: number;
    bytes: number;
    added: number;
    removed: number;
}

export interface CodeMapFolder {
    type: 'folder';
    project: string;
    name: string;
    path: string;
    totals: CodeMapTotals;
    children: CodeMapNode[];
}

export interface CodeMapFile {
    type: 'file';
    project: string;
    name: string;
    path: string;
    stats: FileStats;
}

export type CodeMapNode = CodeMapFolder | CodeMapFile;

export function emptyTotals(): CodeMapTotals {
    return { files: 0, lines: 0, bytes: 0, added: 0, removed: 0 };
}

function addFile(totals: CodeMapTotals, stats: FileStats): void {
    totals.files++;
    totals.lines += stats.lines ?? 0;
    totals.bytes += stats.bytes;
    totals.added += stats.added;
    totals.removed += stats.removed;
}

export function nodeLines(node: CodeMapNode): number {
    return node.type === 'folder' ? node.totals.lines : node.stats.lines ?? 0;
}

function nodeBytes(node: CodeMapNode): number {
    return node.type === 'folder' ? node.totals.bytes : node.stats.bytes;
}

function compareNames(a: CodeMapNode, b: CodeMapNode): number {
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

function comparer(sort: CodeMapSort): (a: CodeMapNode, b: CodeMapNode) => number {
    if (sort === 'name') {
        return (a, b) => (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1) || compareNames(a, b);
    }
    return (a, b) => nodeLines(b) - nodeLines(a) || nodeBytes(b) - nodeBytes(a) || compareNames(a, b);
}

function sortTree(folder: CodeMapFolder, compare: (a: CodeMapNode, b: CodeMapNode) => number): void {
    folder.children.sort(compare);
    folder.children.forEach(child => {
        if (child.type === 'folder') {
            sortTree(child, compare);
        }
    });
}

function parentPath(nodePath: string): string {
    const separator = nodePath.lastIndexOf('/');
    return separator < 0 ? '' : nodePath.slice(0, separator);
}

export function buildCodeMap(project: string, files: readonly FileStats[], sort: CodeMapSort): CodeMapFolder {
    const root: CodeMapFolder = { type: 'folder', project, name: '', path: '', totals: emptyTotals(), children: [] };
    const folders = new Map<string, CodeMapFolder>([['', root]]);
    const folderAt = (folderPath: string): CodeMapFolder => {
        const known = folders.get(folderPath);
        if (known) {
            return known;
        }
        const created: CodeMapFolder = { type: 'folder', project, name: folderPath.slice(folderPath.lastIndexOf('/') + 1), path: folderPath, totals: emptyTotals(), children: [] };
        folderAt(parentPath(folderPath)).children.push(created);
        folders.set(folderPath, created);
        return created;
    };
    for (const stats of files) {
        const folder = folderAt(parentPath(stats.path));
        folder.children.push({ type: 'file', project, name: stats.path.slice(stats.path.lastIndexOf('/') + 1), path: stats.path, stats });
        for (let current: CodeMapFolder | undefined = folder; current; current = current === root ? undefined : folders.get(parentPath(current.path))) {
            addFile(current.totals, stats);
        }
    }
    sortTree(root, comparer(sort));
    return root;
}
