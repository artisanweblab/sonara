import * as path from 'path';
import * as vscode from 'vscode';
import { ReviewServiceHolder } from '../review-service-holder';
import { LEVEL_LABELS, REVIEW_LEVELS_TOP_DOWN, ReviewLevel } from '../types';
import { LevelFileEntry, LevelNode, ReviewNode } from './review-node';
import { LevelSelection } from '../review-level-mover';
import { TreeLayout, buildLevelChildren, collectFiles, collectStates } from './review-tree-builder';

export const OPEN_LEVEL_DIFF_COMMAND = 'sonara.review.openLevelDiff';

export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewNode>, vscode.Disposable {
    static readonly VIEW_ID = 'sonara.review';

    private readonly emitter = new vscode.EventEmitter<ReviewNode | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly holder: ReviewServiceHolder) {
        this.disposables.push(
            holder.onDidChange(() => this.refresh()),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('scm.defaultViewMode') || event.affectsConfiguration('scm.compactFolders')) {
                    this.refresh();
                }
            }),
        );
    }

    refresh(): void {
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
            case 'level': {
                const config = vscode.workspace.getConfiguration('scm');
                return buildLevelChildren(node.level, node.entries, this.currentLayout(), config.get<boolean>('compactFolders', true));
            }
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
                const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
                item.id = `folder/${node.level}/${node.displayPath}`;
                item.iconPath = vscode.ThemeIcon.Folder;
                item.resourceUri = vscode.Uri.file(this.absoluteDisplayPath(node.displayPath));
                item.contextValue = `reviewFolder.${node.level}`;
                return item;
            }
            case 'file': {
                const item = new vscode.TreeItem(path.posix.basename(node.displayPath), vscode.TreeItemCollapsibleState.None);
                item.id = `file/${node.level}/${node.path}`;
                item.iconPath = vscode.ThemeIcon.File;
                item.resourceUri = vscode.Uri.file(this.absoluteDisplayPath(node.displayPath));
                const directory = path.posix.dirname(node.displayPath);
                item.description = this.currentLayout() === 'list' && directory !== '.' ? directory : undefined;
                item.tooltip = node.displayPath;
                item.contextValue = `reviewFile.${node.level}`;
                item.command = { command: OPEN_LEVEL_DIFF_COMMAND, title: 'Open Level Changes', arguments: [node.path, node.level] };
                return item;
            }
        }
    }

    orderedFiles(level: ReviewLevel): string[] {
        const config = vscode.workspace.getConfiguration('scm');
        const nodes = buildLevelChildren(level, this.entriesFor(level), this.currentLayout(), config.get<boolean>('compactFolders', true));
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
        const count = states.length;
        const fileCount = new Set(states.map(entry => entry.atom.path)).size;
        const state = count === 0
            ? vscode.TreeItemCollapsibleState.None
            : level === 'new' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
        const item = new vscode.TreeItem(LEVEL_LABELS[level], state);
        item.id = `level/${level}`;
        item.description = `${fileCount} / ${count}`;
        item.tooltip = `${fileCount} files, ${count} changes`;
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
            entries.push({ path: file.path, displayPath, states, generation: file.generation });
        }
        return entries;
    }

    private currentLayout(): TreeLayout {
        return vscode.workspace.getConfiguration('scm').get<string>('defaultViewMode') === 'tree' ? 'tree' : 'list';
    }

    private absoluteDisplayPath(displayPath: string): string {
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
