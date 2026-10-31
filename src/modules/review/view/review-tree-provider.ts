import * as path from 'path';
import * as vscode from 'vscode';
import { TreeExpansion } from '../../../shared/tree-expansion';
import { ReviewService } from '../review-service';
import { ReviewServices } from '../review-services';
import { LEVEL_LABELS, SHOWN_LEVELS_TOP_DOWN, ReviewAtomState, ShownLevel, reviewLevelOf } from '../types';
import { LevelContentNode, LevelFileEntry, LevelNode, RepositoryNode, ReviewNode } from './review-node';
import { LevelSelection } from '../review-level-mover';
import { treeItemUri } from './review-status-decorations';
import { TreeLayout, buildLevelChildren, collectFiles, LevelSummary, collectStates, summarizeLevel } from './review-tree-builder';

export const OPEN_LEVEL_DIFF_COMMAND = 'sonara.review.openLevelDiff';

const EXPANDED_FOLDER_DEPTH = 1;

export interface ProjectFile {
    project: string;
    path: string;
}

function folderKey(project: string, level: ShownLevel, displayPath: string): string {
    return `${project}::${level}/${displayPath}`;
}

function levelKey(project: string, level: ShownLevel): string {
    return `${project}::level/${level}`;
}

function repositoryKey(project: string): string {
    return `${project}::repository`;
}

function expansionKey(node: ReviewNode): string | null {
    switch (node.type) {
        case 'repository':
            return repositoryKey(node.project);
        case 'level':
            return levelKey(node.project, node.level);
        case 'folder':
            return folderKey(node.project, node.level, node.displayPath);
        case 'file':
            return null;
    }
}

const FILE_STATUSES: readonly { status: string; letter: string; word: string }[] = [
    { status: 'A', letter: 'A', word: 'added' },
    { status: 'M', letter: 'M', word: 'modified' },
    { status: 'D', letter: 'D', word: 'deleted' },
    { status: 'U', letter: 'U', word: 'unmerged' },
];

function describeFiles(summary: LevelSummary, label: string): string {
    const byStatus = FILE_STATUSES
        .filter(entry => (summary.filesByStatus.get(entry.status) ?? 0) > 0)
        .map(entry => `${entry.letter}${summary.filesByStatus.get(entry.status)}`)
        .join(' ');
    return byStatus ? `${label}: ${summary.fileCount} (${byStatus})` : `${label}: ${summary.fileCount}`;
}

function describeChangedFiles(summary: LevelSummary): string {
    return describeFiles(summary, 'changed');
}

function describeLevel(summary: LevelSummary): string {
    return `${describeFiles(summary, 'files')} · ${describeLines(summary)}`;
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
    private readonly expansion = new TreeExpansion<ReviewNode>(expansionKey, node => this.getChildren(node));

    constructor(private readonly services: ReviewServices) {
        this.disposables.push(
            services.onDidChange(() => this.refresh()),
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
        this.expansion.remember(node, isExpanded);
    }

    setSubtreeExpanded(node: ReviewNode, isExpanded: boolean): void {
        this.expansion.setSubtree(node, isExpanded);
        this.emitter.fire(undefined);
    }

    getChildren(node?: ReviewNode): ReviewNode[] {
        if (!node) {
            const services = this.services.all();
            if (services.length === 1) {
                return this.levelsOf(services[0]);
            }
            return services.map(service => ({ type: 'repository', project: service.project.uri.fsPath }));
        }
        switch (node.type) {
            case 'repository': {
                const service = this.services.get(node.project);
                return service ? this.levelsOf(service) : [];
            }
            case 'level':
                return buildLevelChildren(node.project, node.level, node.entries, this.currentLayout(), this.isCompactFolders());
            case 'folder':
                return node.children;
            case 'file':
                return [];
        }
    }

    getTreeItem(node: ReviewNode): vscode.TreeItem {
        switch (node.type) {
            case 'repository':
                return this.repositoryItem(node);
            case 'level':
                return this.levelItem(node);
            case 'folder': {
                const key = folderKey(node.project, node.level, node.displayPath);
                const isExpanded = this.expansion.isExpanded(key, node.depth <= EXPANDED_FOLDER_DEPTH);
                const state = isExpanded
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Collapsed;
                const item = new vscode.TreeItem(node.label, state);
                item.id = `folder/${this.expansion.itemId(key)}`;
                item.iconPath = vscode.ThemeIcon.Folder;
                item.resourceUri = treeItemUri(this.absoluteDisplayPath(node.project, node.displayPath), null);
                const summary = summarizeLevel(collectStates(node));
                item.description = `files: ${summary.fileCount} · ${describeLines(summary)}`;
                item.tooltip = `${node.displayPath}\n${levelTooltip(summary)}`;
                item.contextValue = `reviewFolder.${node.level}`;
                return item;
            }
            case 'file': {
                const item = new vscode.TreeItem(path.posix.basename(node.displayPath), vscode.TreeItemCollapsibleState.None);
                item.id = `file/${node.project}/${node.level}/${node.path}`;
                item.iconPath = vscode.ThemeIcon.File;
                item.resourceUri = treeItemUri(this.absoluteDisplayPath(node.project, node.displayPath), node.status);
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
                item.command = { command: OPEN_LEVEL_DIFF_COMMAND, title: 'Open Level Changes', arguments: [node.project, node.path, reviewLevelOf(node.level)] };
                return item;
            }
        }
    }

    orderedFiles(level: ShownLevel): ProjectFile[] {
        const files: ProjectFile[] = [];
        const visit = (list: readonly ReviewNode[]): void => {
            for (const node of list) {
                if (node.type === 'file') {
                    files.push({ project: node.project, path: node.path });
                } else if (node.type === 'folder') {
                    visit(node.children);
                }
            }
        };
        for (const service of this.services.all()) {
            const project = service.project.uri.fsPath;
            visit(buildLevelChildren(project, level, this.entriesFor(service, level), this.currentLayout(), this.isCompactFolders()));
        }
        return files;
    }

    selectionsOf(node: LevelContentNode): LevelSelection[] {
        const files = node.type === 'level' ? node.entries.map(entry => ({ ...entry, level: node.level })) : collectFiles(node);
        return files.map(file => ({ repoPath: file.path, level: reviewLevelOf(file.level), generation: file.generation }));
    }

    private levelsOf(service: ReviewService): LevelNode[] {
        if (!service.isActive()) {
            return [];
        }
        const project = service.project.uri.fsPath;
        return SHOWN_LEVELS_TOP_DOWN.map(level => ({ type: 'level', project, level, entries: this.entriesFor(service, level) }));
    }

    private repositoryItem(node: RepositoryNode): vscode.TreeItem {
        const service = this.services.get(node.project);
        const key = repositoryKey(node.project);
        const isActive = service?.isActive() ?? false;
        const state = isActive
            ? this.expansion.isExpanded(key, true) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem(service?.project.name ?? path.basename(node.project), state);
        item.id = this.expansion.itemId(key);
        item.iconPath = new vscode.ThemeIcon('repo');
        if (service && isActive) {
            const summary = summarizeLevel(service.getFiles().flatMap(file => file.atoms));
            const newCount = summarizeLevel(service.getAtomsByLevel().get('new') ?? []).fileCount;
            const trackedLines = service.getTrackedLines();
            item.description = [`new: ${newCount}`, describeChangedFiles(summary), trackedLines === null ? '' : `lines: ${trackedLines}`].filter(part => part !== '').join(' · ');
            item.tooltip = `${node.project}\n${countOf(summary.fileCount, 'changed file')}${trackedLines === null ? '' : `\n${countOf(trackedLines, 'line')} in the files tracked by git`}`;
        } else {
            item.description = service?.getIdleReason() || undefined;
            item.tooltip = node.project;
        }
        item.contextValue = 'reviewRepository';
        return item;
    }

    private levelItem(node: LevelNode): vscode.TreeItem {
        const level = node.level;
        const key = levelKey(node.project, level);
        const states = collectStates(node);
        const summary = summarizeLevel(states);
        const isExpanded = this.expansion.isExpanded(key, level === 'new');
        const state = states.length === 0
            ? vscode.TreeItemCollapsibleState.None
            : isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
        const item = new vscode.TreeItem(LEVEL_LABELS[level], state);
        item.id = this.expansion.itemId(key);
        item.description = describeLevel(summary);
        item.tooltip = levelTooltip(summary);
        item.contextValue = `reviewLevel.${level}`;
        return item;
    }

    private entriesFor(service: ReviewService, level: ShownLevel): LevelFileEntry[] {
        const prefix = service.getProjectPrefix();
        const entries: LevelFileEntry[] = [];
        for (const file of service.getFiles()) {
            const states: ReviewAtomState[] = file.atoms.filter(state => service.shownLevelOf(file.path, state.level) === level);
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

    absoluteDisplayPath(project: string, displayPath: string): string {
        const service = this.services.get(project);
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
