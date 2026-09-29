import * as path from 'path';
import * as vscode from 'vscode';
import { ReviewServiceHolder } from '../review-service-holder';
import { LEVEL_LABELS, REVIEW_LEVELS_TOP_DOWN, ReviewLevel } from '../types';
import { FolderNode, LevelFileEntry, LevelNode, ReviewNode } from './review-node';
import { LevelSelection } from '../review-level-mover';
import { treeItemUri } from './review-status-decorations';
import { TreeLayout, buildLevelChildren, collectFiles, LevelSummary, collectStates, summarizeLevel } from './review-tree-builder';

export const OPEN_LEVEL_DIFF_COMMAND = 'sonara.review.openLevelDiff';

const EXPANDED_FOLDER_DEPTH = 1;

function folderKey(level: ReviewLevel, displayPath: string): string {
    return `${level}/${displayPath}`;
}

function expansionKey(node: ReviewNode): string | null {
    if (node.type === 'level') {
        return `level/${node.level}`;
    }
    return node.type === 'folder' ? folderKey(node.level, node.displayPath) : null;
}

const FILE_STATUSES: readonly { status: string; letter: string; word: string }[] = [
    { status: 'A', letter: 'A', word: 'added' },
    { status: 'M', letter: 'M', word: 'modified' },
    { status: 'D', letter: 'D', word: 'deleted' },
    { status: 'U', letter: 'U', word: 'unmerged' },
];

function describeLevel(summary: LevelSummary): string {
    const byStatus = FILE_STATUSES
        .filter(entry => (summary.filesByStatus.get(entry.status) ?? 0) > 0)
        .map(entry => `${entry.letter}${summary.filesByStatus.get(entry.status)}`)
        .join(' ');
    const files = byStatus ? `files: ${summary.fileCount} (${byStatus})` : `files: ${summary.fileCount}`;
    return `${files} · ${describeLines(summary)}`;
}

function describeLines(summary: LevelSummary): string {
    return `lines: +${summary.addedLines} -${summary.removedLines}`;
}

function levelTooltip(summary: LevelSummary): string {
    const byStatus = FILE_STATUSES
        .filter(entry => (summary.filesByStatus.get(entry.status) ?? 0) > 0)
        .map(entry => `${summary.filesByStatus.get(entry.status)} ${entry.word}`)
        .join(', ');
    const files = byStatus ? `${countOf(summary.fileCount, 'file')}: ${byStatus}` : countOf(summary.fileCount, 'file');
    return `${files}\n${countOf(summary.addedLines, 'line')} added, ${countOf(summary.removedLines, 'line')} removed`;
}

function countOf(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewNode>, vscode.Disposable {
    static readonly VIEW_ID = 'sonara.review';

    private readonly emitter = new vscode.EventEmitter<ReviewNode | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly expansion = new Map<string, boolean>();
    private readonly revisions = new Map<string, number>();

    constructor(private readonly holder: ReviewServiceHolder) {
        this.disposables.push(
            holder.onDidChange(() => this.refresh()),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('sonara.review.viewMode') || event.affectsConfiguration('sonara.review.compactFolders')) {
                    this.publishViewMode();
                    this.refresh();
                }
            }),
        );
        this.publishViewMode();
    }

    refresh(): void {
        this.emitter.fire(undefined);
    }

    rememberExpanded(node: ReviewNode, isExpanded: boolean): void {
        const key = expansionKey(node);
        if (key) {
            this.expansion.set(key, isExpanded);
        }
    }

    setSubtreeExpanded(node: ReviewNode, isExpanded: boolean): void {
        const key = expansionKey(node);
        if (!key) {
            return;
        }
        const apply = (target: ReviewNode, targetKey: string): void => {
            this.expansion.set(targetKey, isExpanded);
            this.revisions.set(targetKey, (this.revisions.get(targetKey) ?? 0) + 1);
            for (const child of this.getChildren(target)) {
                const childKey = expansionKey(child);
                if (childKey) {
                    apply(child, childKey);
                }
            }
        };
        apply(node, key);
        this.emitter.fire(undefined);
    }

    getChildren(node?: ReviewNode): ReviewNode[] {
        const service = this.holder.get();
        if (!service || !service.isActive()) {
            return [];
        }
        if (!node) {
            return REVIEW_LEVELS_TOP_DOWN.map(level => ({ type: 'level', level, entries: this.entriesFor(level) }));
        }
        switch (node.type) {
            case 'level':
                return buildLevelChildren(node.level, node.entries, this.currentLayout(), this.isCompactFolders());
            case 'folder':
                return node.children;
            case 'file':
                return [];
        }
    }

    getTreeItem(node: ReviewNode): vscode.TreeItem {
        switch (node.type) {
            case 'level':
                return this.levelItem(node);
            case 'folder': {
                const key = folderKey(node.level, node.displayPath);
                const isExpanded = this.expansion.get(key) ?? node.depth <= EXPANDED_FOLDER_DEPTH;
                const state = isExpanded
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Collapsed;
                const item = new vscode.TreeItem(node.label, state);
                item.id = `folder/${key}#${this.revisions.get(key) ?? 0}`;
                item.iconPath = vscode.ThemeIcon.Folder;
                item.resourceUri = treeItemUri(this.absoluteDisplayPath(node.displayPath), null);
                const summary = summarizeLevel(collectStates(node));
                item.description = `files: ${summary.fileCount} · ${describeLines(summary)}`;
                item.tooltip = `${node.displayPath}\n${levelTooltip(summary)}`;
                item.contextValue = `reviewFolder.${node.level}`;
                return item;
            }
            case 'file': {
                const item = new vscode.TreeItem(path.posix.basename(node.displayPath), vscode.TreeItemCollapsibleState.None);
                item.id = `file/${node.level}/${node.path}`;
                item.iconPath = vscode.ThemeIcon.File;
                item.resourceUri = treeItemUri(this.absoluteDisplayPath(node.displayPath), node.status);
                const directory = path.posix.dirname(node.displayPath);
                const location = this.currentLayout() === 'list' && directory !== '.' ? directory : '';
                const summary = summarizeLevel(node.states);
                const hasLines = summary.addedLines + summary.removedLines > 0;
                const lines = hasLines ? `+${summary.addedLines} -${summary.removedLines}` : '';
                item.description = [lines, location].filter(part => part !== '').join(' · ') || undefined;
                item.tooltip = hasLines
                    ? `${node.displayPath}\n${countOf(summary.addedLines, 'line')} added, ${countOf(summary.removedLines, 'line')} removed`
                    : node.displayPath;
                item.contextValue = `reviewFile.${node.level}`;
                item.command = { command: OPEN_LEVEL_DIFF_COMMAND, title: 'Open Level Changes', arguments: [node.path, node.level] };
                return item;
            }
        }
    }

    orderedFiles(level: ReviewLevel): string[] {
        const nodes = buildLevelChildren(level, this.entriesFor(level), this.currentLayout(), this.isCompactFolders());
        const paths: string[] = [];
        const visit = (list: readonly ReviewNode[]): void => {
            for (const node of list) {
                if (node.type === 'file') {
                    paths.push(node.path);
                } else if (node.type === 'folder') {
                    visit(node.children);
                }
            }
        };
        visit(nodes);
        return paths;
    }

    selectionsOf(node: ReviewNode): LevelSelection[] {
        const files = node.type === 'level' ? node.entries.map(entry => ({ ...entry, level: node.level })) : collectFiles(node);
        return files.map(file => ({ repoPath: file.path, level: file.level, generation: file.generation }));
    }

    private levelItem(node: LevelNode): vscode.TreeItem {
        const level = node.level;
        const states = collectStates(node);
        const summary = summarizeLevel(states);
        const isExpanded = this.expansion.get(`level/${level}`) ?? level === 'new';
        const state = states.length === 0
            ? vscode.TreeItemCollapsibleState.None
            : isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
        const item = new vscode.TreeItem(LEVEL_LABELS[level], state);
        item.id = `level/${level}#${this.revisions.get(`level/${level}`) ?? 0}`;
        item.description = describeLevel(summary);
        item.tooltip = levelTooltip(summary);
        item.contextValue = `reviewLevel.${level}`;
        return item;
    }

    private entriesFor(level: ReviewLevel): LevelFileEntry[] {
        const service = this.holder.get();
        if (!service) {
            return [];
        }
        const prefix = service.getProjectPrefix();
        const entries: LevelFileEntry[] = [];
        for (const file of service.getFiles()) {
            const states = file.atoms.filter(state => state.level === level);
            if (states.length === 0) {
                continue;
            }
            const displayPath = prefix && file.path.startsWith(`${prefix}/`) ? file.path.slice(prefix.length + 1) : file.path;
            entries.push({ path: file.path, displayPath, states, generation: file.generation, status: states[0].status });
        }
        return entries;
    }

    private currentLayout(): TreeLayout {
        return vscode.workspace.getConfiguration('sonara.review').get<string>('viewMode') === 'list' ? 'list' : 'tree';
    }

    private isCompactFolders(): boolean {
        return vscode.workspace.getConfiguration('sonara.review').get<boolean>('compactFolders', true);
    }

    private publishViewMode(): void {
        void vscode.commands.executeCommand('setContext', 'sonara.review.viewMode', this.currentLayout());
    }

    absoluteDisplayPath(displayPath: string): string {
        const service = this.holder.get();
        if (!service) {
            return displayPath;
        }
        const prefix = service.getProjectPrefix();
        return service.absolutePath(prefix ? `${prefix}/${displayPath}` : displayPath);
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.emitter.dispose();
    }
}
