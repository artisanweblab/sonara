import * as vscode from 'vscode';
import { ActiveProject } from '../../shared/active-project';
import { PathTarget, copyPaths, distinctTargets, moveToTrash, revealInOS, selectedNodes } from '../../shared/file-actions';
import { describeTotals } from './code-map-format';
import { CodeMapProvider } from './code-map-provider';
import { CodeMapSession, CodeMapState } from './code-map-session';
import { CodeMapNode, CodeMapSort } from './code-map-tree';

const VIEW_ID = 'sonara.codeMap';
const SORT_CONTEXT = 'sonara.codeMap.sortBy';

function currentSort(): CodeMapSort {
    return vscode.workspace.getConfiguration('sonara.codeMap').get<string>('sortBy') === 'name' ? 'name' : 'lines';
}

export function registerCodeMapModule(context: vscode.ExtensionContext, activeProject: ActiveProject): void {
    const provider = new CodeMapProvider(currentSort());
    const treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true, canSelectMany: true });
    let session: CodeMapSession | undefined;

    const targetsOf = (node: CodeMapNode | undefined, selection: readonly CodeMapNode[] | undefined): PathTarget[] =>
        distinctTargets(selectedNodes(node, selection).flatMap(current => {
            const uri = provider.uriOf(current);
            return uri ? [{ uri, isFolder: current.type === 'folder' }] : [];
        }));

    const showState = (state: CodeMapState): void => {
        if (!session) {
            return;
        }
        if (state.kind === 'problem') {
            provider.clear();
            treeView.description = undefined;
            treeView.message = state.message;
            return;
        }
        const root = provider.show(session.folder.uri, state.files);
        treeView.description = describeTotals(root.totals);
        treeView.message = state.files.length === 0 ? 'No files under git in this project yet.' : undefined;
    };

    const startSession = (): void => {
        session?.dispose();
        session = undefined;
        const folder = activeProject.get();
        if (!folder) {
            provider.clear();
            treeView.description = undefined;
            treeView.message = 'Open a project folder to see its Code Map.';
            return;
        }
        session = new CodeMapSession(folder);
        session.onDidChange(showState);
        session.start();
    };

    const startWhenVisible = (): void => {
        if (treeView.visible && !session) {
            startSession();
        }
    };

    const setSort = async (sort: CodeMapSort): Promise<void> => {
        await vscode.workspace.getConfiguration('sonara.codeMap').update('sortBy', sort, vscode.ConfigurationTarget.Global);
    };

    void vscode.commands.executeCommand('setContext', SORT_CONTEXT, currentSort());
    context.subscriptions.push(
        provider,
        treeView,
        new vscode.Disposable(() => session?.dispose()),
        treeView.onDidChangeVisibility(startWhenVisible),
        treeView.onDidExpandElement(event => provider.rememberExpanded(event.element, true)),
        treeView.onDidCollapseElement(event => provider.rememberExpanded(event.element, false)),
        activeProject.onDidChange(() => {
            if (session || treeView.visible) {
                startSession();
            }
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('sonara.codeMap.sortBy')) {
                const sort = currentSort();
                void vscode.commands.executeCommand('setContext', SORT_CONTEXT, sort);
                provider.setSort(sort);
            }
        }),
        vscode.commands.registerCommand('sonara.codeMap.sortByName', () => setSort('name')),
        vscode.commands.registerCommand('sonara.codeMap.sortByLines', () => setSort('lines')),
        vscode.commands.registerCommand('sonara.codeMap.refresh', () => session ? session.requestScan() : startSession()),
        vscode.commands.registerCommand('sonara.codeMap.expandFolder', (node: CodeMapNode) => provider.setSubtreeExpanded(node, true)),
        vscode.commands.registerCommand('sonara.codeMap.collapseFolder', (node: CodeMapNode) => provider.setSubtreeExpanded(node, false)),
        vscode.commands.registerCommand('sonara.codeMap.revealInOS', (node: CodeMapNode | undefined) => {
            const [target] = targetsOf(node, undefined);
            return revealInOS(target, `Sonara Code Map: ${target ? vscode.workspace.asRelativePath(target.uri, false) : ''} is no longer on disk.`);
        }),
        vscode.commands.registerCommand('sonara.codeMap.copyPath', (node: CodeMapNode | undefined, selection: CodeMapNode[] | undefined) =>
            copyPaths(targetsOf(node, selection), 'absolute')),
        vscode.commands.registerCommand('sonara.codeMap.copyRelativePath', (node: CodeMapNode | undefined, selection: CodeMapNode[] | undefined) =>
            copyPaths(targetsOf(node, selection), 'relative')),
        vscode.commands.registerCommand('sonara.codeMap.delete', (node: CodeMapNode | undefined, selection: CodeMapNode[] | undefined) =>
            moveToTrash(targetsOf(node, selection), {
                source: 'Sonara Code Map',
                nothingOnDisk: 'Sonara Code Map: the selection is no longer on disk.',
                folderNote: 'A folder is deleted with everything in it, including files that git ignores.',
            })),
    );
    startWhenVisible();
}
