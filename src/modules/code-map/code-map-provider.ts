import * as vscode from 'vscode';
import { SonaraProject } from '../../shared/sonara-project';
import { describeFile, describeTotals } from './code-map-format';
import { CodeMapState } from './code-map-session';
import { TreeExpansion } from '../../shared/tree-expansion';
import { CodeMapFolder, CodeMapNode, CodeMapSort, CodeMapTotals, buildCodeMap, emptyTotals } from './code-map-tree';

export interface CodeMapRepository {
    type: 'repository';
    project: string;
}

export type CodeMapItem = CodeMapRepository | CodeMapNode;

interface ProjectMap {
    project: SonaraProject;
    state: CodeMapState | undefined;
    root: CodeMapFolder | undefined;
}

function expansionKey(node: CodeMapItem): string | null {
    if (node.type === 'repository') {
        return `${node.project}::repository`;
    }
    return node.type === 'folder' ? `${node.project}::folder:${node.path}` : null;
}

export class CodeMapProvider implements vscode.TreeDataProvider<CodeMapItem>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<CodeMapItem | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;

    private readonly expansion = new TreeExpansion<CodeMapItem>(expansionKey, node => this.getChildren(node));
    private maps: ProjectMap[] = [];

    constructor(private sort: CodeMapSort) {}

    rememberExpanded(node: CodeMapItem, isExpanded: boolean): void {
        this.expansion.remember(node, isExpanded);
    }

    setSubtreeExpanded(node: CodeMapItem, isExpanded: boolean): void {
        this.expansion.setSubtree(node, isExpanded);
        this.emitter.fire(undefined);
    }

    uriOf(node: CodeMapItem): vscode.Uri | undefined {
        const map = this.mapOf(node.project);
        if (!map) {
            return undefined;
        }
        return node.type === 'repository' ? map.project.uri : vscode.Uri.joinPath(map.project.uri, node.path);
    }

    setProjects(projects: readonly SonaraProject[]): void {
        this.maps = projects.map(project => this.mapOf(project.uri.fsPath) ?? { project, state: undefined, root: undefined });
        this.emitter.fire(undefined);
    }

    showState(project: string, state: CodeMapState): void {
        const map = this.mapOf(project);
        if (!map) {
            return;
        }
        map.state = state;
        map.root = state.kind === 'files' ? buildCodeMap(project, state.files, this.sort) : undefined;
        this.emitter.fire(undefined);
    }

    setSort(sort: CodeMapSort): void {
        this.sort = sort;
        for (const map of this.maps) {
            if (map.state?.kind === 'files') {
                map.root = buildCodeMap(map.project.uri.fsPath, map.state.files, sort);
            }
        }
        this.emitter.fire(undefined);
    }

    projectStates(): ReadonlyArray<{ project: SonaraProject; state: CodeMapState | undefined }> {
        return this.maps;
    }

    totals(): CodeMapTotals {
        const totals = emptyTotals();
        for (const root of this.maps.map(map => map.root)) {
            if (root) {
                totals.files += root.totals.files;
                totals.lines += root.totals.lines;
                totals.bytes += root.totals.bytes;
                totals.added += root.totals.added;
                totals.removed += root.totals.removed;
            }
        }
        return totals;
    }

    getChildren(node?: CodeMapItem): CodeMapItem[] {
        if (!node) {
            if (this.maps.length === 1) {
                return this.maps[0].root?.children ?? [];
            }
            return this.maps.map(map => ({ type: 'repository', project: map.project.uri.fsPath }));
        }
        if (node.type === 'repository') {
            return this.mapOf(node.project)?.root?.children ?? [];
        }
        return node.type === 'folder' ? node.children : [];
    }

    getTreeItem(node: CodeMapItem): vscode.TreeItem {
        if (node.type === 'repository') {
            return this.repositoryItem(node);
        }
        const resourceUri = this.uriOf(node);
        if (node.type === 'folder') {
            const key = `${node.project}::folder:${node.path}`;
            const isExpanded = this.expansion.isExpanded(key, false);
            const item = new vscode.TreeItem(node.name, isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
            item.id = this.expansion.itemId(key);
            item.contextValue = 'codeMapFolder';
            item.resourceUri = resourceUri;
            item.iconPath = vscode.ThemeIcon.Folder;
            item.description = describeTotals(node.totals);
            item.tooltip = `${node.path}\n${item.description}`;
            return item;
        }
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
        item.id = `file:${node.project}:${node.path}`;
        item.contextValue = 'codeMapFile';
        item.resourceUri = resourceUri;
        item.iconPath = vscode.ThemeIcon.File;
        item.description = describeFile(node.stats);
        item.tooltip = `${node.path}\n${item.description}`;
        item.command = resourceUri ? { command: 'vscode.open', title: 'Open', arguments: [resourceUri] } : undefined;
        return item;
    }

    dispose(): void {
        this.emitter.dispose();
    }

    private repositoryItem(node: CodeMapRepository): vscode.TreeItem {
        const map = this.mapOf(node.project);
        const key = `${node.project}::repository`;
        const root = map?.root;
        const state = root && root.children.length > 0
            ? this.expansion.isExpanded(key, true) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem(map?.project.name ?? node.project, state);
        item.id = this.expansion.itemId(key);
        item.contextValue = 'codeMapRepository';
        item.resourceUri = map?.project.uri;
        item.iconPath = new vscode.ThemeIcon('repo');
        if (map?.state?.kind === 'problem') {
            item.description = map.state.message;
        } else if (root) {
            item.description = describeTotals(root.totals);
        } else {
            item.description = 'counting...';
        }
        item.tooltip = `${node.project}\n${item.description}`;
        return item;
    }

    private mapOf(project: string): ProjectMap | undefined {
        return this.maps.find(map => map.project.uri.fsPath === project);
    }
}
