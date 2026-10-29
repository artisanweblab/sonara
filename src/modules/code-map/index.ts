import * as vscode from 'vscode';
import { ProjectCatalog } from '../../shared/project-catalog';
import { PathTarget, copyPaths, distinctTargets, moveToTrash, openWithDefaultApp, revealInOS, selectedNodes } from '../../shared/file-actions';
import { describeTotals } from './code-map-format';
import { CodeMapItem, CodeMapProvider } from './code-map-provider';
import { CodeMapSession } from './code-map-session';
import { CodeMapSort } from './code-map-tree';

const VIEW_ID = 'sonara.codeMap';
const SORT_CONTEXT = 'sonara.codeMap.sortBy';

function currentSort(): CodeMapSort {
    return vscode.workspace.getConfiguration('sonara.codeMap').get<string>('sortBy') === 'name' ? 'name' : 'lines';
}

export function registerCodeMapModule(context: vscode.ExtensionContext, catalog: ProjectCatalog): void {
    const provider = new CodeMapProvider(currentSort());
    const treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true, canSelectMany: true });
    const sessions = new Map<string, CodeMapSession>();
    let isStarted = false;

    const targetsOf = (nodes: readonly CodeMapItem[]): PathTarget[] =>
        distinctTargets(nodes.flatMap(current => {
            const uri = provider.uriOf(current);
            return uri ? [{ uri, isFolder: current.type !== 'file' }] : [];
        }));

    const updateHeader = (): void => {
        const states = provider.projectStates();
        if (states.length === 0) {
            treeView.description = undefined;
            treeView.message = `Sonara Code Map needs a git repository: ${catalog.describeMissingGit()}.`;
            return;
        }
        const [single] = states;
        if (states.length === 1 && single.state?.kind === 'problem') {
            treeView.description = undefined;
            treeView.message = single.state.message;
            return;
        }
        const totals = provider.totals();
        treeView.description = describeTotals(totals);
        treeView.message = states.length === 1 && single.state?.kind === 'files' && single.state.files.length === 0
            ? 'No files under git in this project yet.'
            : undefined;
    };

    const syncSessions = (): void => {
        if (!isStarted) {
            return;
        }
        const projects = catalog.gitProjects();
        const wanted = new Set(projects.map(project => project.uri.fsPath));
        for (const [key, session] of sessions) {
            if (!wanted.has(key)) {
                session.dispose();
                sessions.delete(key);
            }
        }
        provider.setProjects(projects);
        for (const project of projects) {
            const key = project.uri.fsPath;
            if (!sessions.has(key)) {
                const session = new CodeMapSession(project);
                sessions.set(key, session);
                session.onDidChange(state => {
                    provider.showState(key, state);
                    updateHeader();
                });
                session.start();
            }
        }
        updateHeader();
    };

    const startWhenVisible = (): void => {
        if (treeView.visible && !isStarted) {
            isStarted = true;
            syncSessions();
        }
    };

    const setSort = async (sort: CodeMapSort): Promise<void> => {
        await vscode.workspace.getConfiguration('sonara.codeMap').update('sortBy', sort, vscode.ConfigurationTarget.Global);
    };

    void vscode.commands.executeCommand('setContext', SORT_CONTEXT, currentSort());
    context.subscriptions.push(
        provider,
        treeView,
        new vscode.Disposable(() => sessions.forEach(session => session.dispose())),
        treeView.onDidChangeVisibility(startWhenVisible),
        treeView.onDidExpandElement(event => provider.rememberExpanded(event.element, true)),
        treeView.onDidCollapseElement(event => provider.rememberExpanded(event.element, false)),
        catalog.onDidChange(syncSessions),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('sonara.codeMap.sortBy')) {
                const sort = currentSort();
                void vscode.commands.executeCommand('setContext', SORT_CONTEXT, sort);
                provider.setSort(sort);
            }
        }),
        vscode.commands.registerCommand('sonara.codeMap.sortByName', () => setSort('name')),
        vscode.commands.registerCommand('sonara.codeMap.sortByLines', () => setSort('lines')),
        vscode.commands.registerCommand('sonara.codeMap.refresh', () => {
            if (!isStarted) {
                isStarted = true;
                syncSessions();
                return;
            }
            sessions.forEach(session => session.requestScan());
        }),
        vscode.commands.registerCommand('sonara.codeMap.expandFolder', (node: CodeMapItem) => provider.setSubtreeExpanded(node, true)),
        vscode.commands.registerCommand('sonara.codeMap.collapseFolder', (node: CodeMapItem) => provider.setSubtreeExpanded(node, false)),
        vscode.commands.registerCommand('sonara.codeMap.revealInOS', (node: CodeMapItem | undefined) => {
            const [target] = targetsOf(selectedNodes(node, undefined));
            return revealInOS(target, `Sonara Code Map: ${target ? vscode.workspace.asRelativePath(target.uri, false) : ''} is no longer on disk.`);
        }),
        vscode.commands.registerCommand('sonara.codeMap.openWithDefaultApp', (node: CodeMapItem | undefined, selection: CodeMapItem[] | undefined) =>
            openWithDefaultApp(targetsOf(selectedNodes(node, selection)), 'Sonara Code Map: the file is no longer on disk.')),
        vscode.commands.registerCommand('sonara.codeMap.copyPath', (node: CodeMapItem | undefined, selection: CodeMapItem[] | undefined) =>
            copyPaths(targetsOf(selectedNodes(node, selection)), 'absolute')),
        vscode.commands.registerCommand('sonara.codeMap.copyRelativePath', (node: CodeMapItem | undefined, selection: CodeMapItem[] | undefined) =>
            copyPaths(targetsOf(selectedNodes(node, selection)), 'relative')),
        vscode.commands.registerCommand('sonara.codeMap.delete', (node: CodeMapItem | undefined, selection: CodeMapItem[] | undefined) =>
            moveToTrash(targetsOf(selectedNodes(node, selection).filter(current => current.type !== 'repository')), {
                source: 'Sonara Code Map',
                nothingOnDisk: 'Sonara Code Map: the selection is no longer on disk.',
                folderNote: 'A folder is deleted with everything in it, including files that git ignores.',
            })),
    );
    startWhenVisible();
}
