import * as vscode from 'vscode';
import { describeFile, describeTotals } from './code-map-format';
import { FileStats } from './code-map-scanner';
import { TreeExpansion } from '../../shared/tree-expansion';
import { CodeMapFolder, CodeMapNode, CodeMapSort, buildCodeMap } from './code-map-tree';

function folderKey(folderPath: string): string {
    return `folder:${folderPath}`;
}

function expansionKey(node: CodeMapNode): string | null {
    return node.type === 'folder' ? folderKey(node.path) : null;
}

export class CodeMapProvider implements vscode.TreeDataProvider<CodeMapNode>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<CodeMapNode | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;

    private readonly expansion = new TreeExpansion<CodeMapNode>(expansionKey, node => this.getChildren(node));
    private root: CodeMapFolder | undefined;
    private files: readonly FileStats[] = [];
    private folderUri: vscode.Uri | undefined;

    constructor(private sort: CodeMapSort) {}

    rememberExpanded(node: CodeMapNode, isExpanded: boolean): void {
        this.expansion.remember(node, isExpanded);
    }

    setSubtreeExpanded(node: CodeMapNode, isExpanded: boolean): void {
        this.expansion.setSubtree(node, isExpanded);
        this.emitter.fire(undefined);
    }

    uriOf(node: CodeMapNode): vscode.Uri | undefined {
        return this.folderUri ? vscode.Uri.joinPath(this.folderUri, node.path) : undefined;
    }

    show(folderUri: vscode.Uri, files: readonly FileStats[]): CodeMapFolder {
        this.folderUri = folderUri;
        this.files = files;
        return this.rebuild();
    }

    clear(): void {
        this.folderUri = undefined;
        this.files = [];
        this.root = undefined;
        this.emitter.fire(undefined);
    }

    setSort(sort: CodeMapSort): void {
        this.sort = sort;
        if (this.folderUri) {
            this.rebuild();
        }
    }

    getChildren(node?: CodeMapNode): CodeMapNode[] {
        if (!node) {
            return this.root?.children ?? [];
        }
        return node.type === 'folder' ? node.children : [];
    }

    getTreeItem(node: CodeMapNode): vscode.TreeItem {
        const resourceUri = this.uriOf(node);
        if (node.type === 'folder') {
            const key = folderKey(node.path);
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
        item.id = `file:${node.path}`;
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

    private rebuild(): CodeMapFolder {
        this.root = buildCodeMap(this.files, this.sort);
        this.emitter.fire(undefined);
        return this.root;
    }
}
