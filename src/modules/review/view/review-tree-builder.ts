import { ReviewAtomState, ReviewLevel } from '../types';
import { FileNode, FolderNode, LevelFileEntry, ReviewNode } from './review-node';

export type TreeLayout = 'tree' | 'list';

function compareNodes(a: ReviewNode, b: ReviewNode): number {
    if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1;
    }
    const nameA = a.type === 'folder' ? a.label : a.type === 'file' ? a.displayPath : '';
    const nameB = b.type === 'folder' ? b.label : b.type === 'file' ? b.displayPath : '';
    return nameA.localeCompare(nameB);
}

function sortTree(nodes: ReviewNode[]): ReviewNode[] {
    for (const node of nodes) {
        if (node.type === 'folder') {
            sortTree(node.children);
        }
    }
    return nodes.sort(compareNodes);
}

function compactFolder(folder: FolderNode): FolderNode {
    let current = folder;
    while (current.children.length === 1 && current.children[0].type === 'folder') {
        const child: FolderNode = current.children[0];
        current = {
            ...child,
            label: `${current.label}/${child.label}`,
        };
    }
    current.children = current.children.map(child => child.type === 'folder' ? compactFolder(child) : child);
    return current;
}

function assignDepth(nodes: readonly ReviewNode[], depth: number): void {
    for (const node of nodes) {
        if (node.type === 'folder') {
            node.depth = depth;
            assignDepth(node.children, depth + 1);
        }
    }
}

export function buildLevelChildren(
    level: ReviewLevel,
    entries: readonly LevelFileEntry[],
    layout: TreeLayout,
    compact: boolean,
): ReviewNode[] {
    const files: FileNode[] = entries.map(entry => ({ type: 'file', level, ...entry }));
    if (layout === 'list') {
        return files.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
    }
    const root: ReviewNode[] = [];
    const folders = new Map<string, FolderNode>();
    for (const file of files) {
        const segments = file.displayPath.split('/');
        let siblings = root;
        let folderPath = '';
        for (const segment of segments.slice(0, -1)) {
            folderPath = folderPath ? `${folderPath}/${segment}` : segment;
            let folder = folders.get(folderPath);
            if (!folder) {
                folder = { type: 'folder', level, displayPath: folderPath, label: segment, depth: 1, children: [] };
                folders.set(folderPath, folder);
                siblings.push(folder);
            }
            siblings = folder.children;
        }
        siblings.push(file);
    }
    const nodes = compact ? root.map(node => node.type === 'folder' ? compactFolder(node) : node) : root;
    assignDepth(nodes, 1);
    return sortTree(nodes);
}

export function collectFiles(node: ReviewNode): FileNode[] {
    switch (node.type) {
        case 'file':
            return [node];
        case 'folder':
            return node.children.flatMap(child => collectFiles(child));
        case 'level':
            return [];
    }
}

export function collectStates(node: ReviewNode): ReviewAtomState[] {
    switch (node.type) {
        case 'file':
            return node.states;
        case 'folder':
            return node.children.flatMap(child => collectStates(child));
        case 'level':
            return node.entries.flatMap(entry => entry.states);
    }
}
