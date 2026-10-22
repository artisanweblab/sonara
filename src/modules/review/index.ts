import * as vscode from 'vscode';
import { ProjectCatalog } from '../../shared/project-catalog';
import { reviewDir } from '../../shared/project-layout';
import { registerLoggedCommand } from '../../shared/output-log';
import { withTimestamps } from '../../shared/timestamped-channel';
import { ReviewCliLauncher } from './cli/launcher-installer';
import { OutputReviewLogger } from './logging/output-review-logger';
import { ReviewLogger } from './logging/review-logger';
import { executeMoveChange, executeMoveChangeAtCursor, executeNavigateNewChange } from './commands/change-commands';
import { executeCopyPaths, executeDelete, executeRevealInOS } from './commands/file-system-commands';
import { MoveDirection, executeMoveLevel } from './commands/move-level-command';
import { executeCheckStorage } from './commands/check-storage-command';
import { executeOpenPreview } from './commands/preview-command';
import { executeShowActions } from './commands/actions-menu-command';
import { executeShowSummary } from './commands/show-summary-command';
import { ReviewService, inactiveMessage } from './review-service';
import { ReviewServices } from './review-services';
import { REVIEW_LEVELS, ReviewLevel } from './types';
import { ChangeMoveDirection, LevelChangeLensProvider, MOVE_CHANGE_COMMAND, ProjectChangeReference } from './view/level-change-lens-provider';
import { DiffCodeLensPrompt } from './view/diff-code-lens-prompt';
import { BinaryLevelPreview } from './view/binary-level-preview';
import { LevelDocumentProvider } from './view/level-document-provider';
import { ReviewDiffOpener } from './view/review-diff-opener';
import { ReviewNode } from './view/review-node';
import { OPEN_LEVEL_DIFF_COMMAND, ReviewTreeProvider } from './view/review-tree-provider';
import { summarizeLevel } from './view/review-tree-builder';
import { ReviewStatusDecorations } from './view/review-status-decorations';
import { ReviewStatusBar } from './view/review-status-bar';

const FOCUS_COMMAND = `${ReviewTreeProvider.VIEW_ID}.focus`;

function levelMoveCommands(): ReadonlyArray<[string, MoveDirection]> {
    return REVIEW_LEVELS.flatMap<[string, MoveDirection]>(level => {
        const suffix = `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;
        return [[`sonara.review.moveTo${suffix}`, level], [`sonara.review.moveAllTo${suffix}`, level]];
    });
}

const MOVE_COMMANDS: ReadonlyArray<[string, MoveDirection]> = [
    ['sonara.review.moveUp', 'up'],
    ['sonara.review.moveDown', 'down'],
    ['sonara.review.moveAllUp', 'up'],
    ['sonara.review.moveAllDown', 'down'],
    ...levelMoveCommands(),
];

const CHANGE_AT_CURSOR_COMMANDS: ReadonlyArray<[string, ChangeMoveDirection]> = [
    ['sonara.review.moveChangeUp', 'up'],
    ['sonara.review.moveChangeDown', 'down'],
    ['sonara.review.moveChangeToLevel', 'pick'],
];

function describeArgument(value: unknown): string {
    if (value instanceof vscode.Uri) {
        return value.toString();
    }
    if (typeof value === 'object' && value !== null) {
        const candidate = value as { type?: unknown; level?: unknown; path?: unknown; displayPath?: unknown; repoPath?: unknown; changeId?: unknown };
        return JSON.stringify({
            type: candidate.type,
            level: candidate.level,
            path: candidate.path ?? candidate.repoPath ?? candidate.displayPath,
            changeId: candidate.changeId,
        });
    }
    return JSON.stringify(value) ?? String(value);
}

function describeArguments(args: readonly unknown[]): string {
    return args.map(argument => Array.isArray(argument)
        ? `[${argument.map(describeArgument).join(', ')}]`
        : describeArgument(argument)).join(' ');
}

async function setViewMode(mode: 'tree' | 'list'): Promise<void> {
    await vscode.workspace.getConfiguration('sonara.review').update('viewMode', mode, vscode.ConfigurationTarget.Global);
}

function loggedCommand(logger: ReviewLogger, command: string, handler: (...args: unknown[]) => unknown): vscode.Disposable {
    return registerLoggedCommand(logger, 'Sonara Review', command, handler, describeArguments);
}

function newChangesBadge(services: readonly ReviewService[]): vscode.ViewBadge | undefined {
    const summaries = services.map(service => summarizeLevel(service.getAtomsByLevel().get('new') ?? []));
    const files = summaries.reduce((sum, summary) => sum + summary.fileCount, 0);
    const added = summaries.reduce((sum, summary) => sum + summary.addedLines, 0);
    const removed = summaries.reduce((sum, summary) => sum + summary.removedLines, 0);
    return files > 0
        ? { value: files, tooltip: `${files} ${files === 1 ? 'file has' : 'files have'} changes on New, lines: +${added} -${removed}` }
        : undefined;
}

function viewMessage(services: readonly ReviewService[], catalog: ProjectCatalog): string | undefined {
    if (services.length === 0) {
        return `Sonara Review is not active: ${catalog.describeMissingGit()}.`;
    }
    const [single] = services;
    return services.length === 1 && !single.isActive() && single.getIdleReason() ? inactiveMessage(single) : undefined;
}

export function registerReviewModule(context: vscode.ExtensionContext, catalog: ProjectCatalog): void {
    const channel = vscode.window.createOutputChannel('Sonara Review');
    const output = withTimestamps(channel);
    let isDebugLog = vscode.workspace.getConfiguration('sonara.review').get<boolean>('debugLog', false);
    const logger = new OutputReviewLogger(channel, () => isDebugLog);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('sonara.review.debugLog')) {
            isDebugLog = vscode.workspace.getConfiguration('sonara.review').get<boolean>('debugLog', false);
        }
    }));
    const services = new ReviewServices(project => {
        logger.info(`Review project: ${project.uri.fsPath}`);
        ReviewCliLauncher.install(project.uri.fsPath, context.extensionPath, logger);
        const service = new ReviewService(project, logger);
        service.start().catch(error => {
            logger.error(`Review failed to start for ${project.uri.fsPath}`, error);
        });
        return service;
    });
    const provider = new ReviewTreeProvider(services);
    const treeView = vscode.window.createTreeView(ReviewTreeProvider.VIEW_ID, {
        treeDataProvider: provider,
        canSelectMany: true,
        showCollapseAll: true,
    });
    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(new ReviewStatusDecorations()),
        treeView.onDidExpandElement(event => provider.rememberExpanded(event.element, true)),
        treeView.onDidCollapseElement(event => provider.rememberExpanded(event.element, false)),
    );
    const updateView = (): void => {
        const running = services.all();
        treeView.message = viewMessage(running, catalog);
        treeView.badge = newChangesBadge(running.filter(service => service.isActive()));
    };
    context.subscriptions.push(services.onDidChange(updateView));
    const documents = new LevelDocumentProvider(services);
    const binaryPreview = new BinaryLevelPreview(vscode.Uri.joinPath(context.globalStorageUri, 'review-binary-preview'));
    void binaryPreview.clear();
    const opener = new ReviewDiffOpener(documents, new DiffCodeLensPrompt(context.globalState, logger), services, binaryPreview);
    const lenses = new LevelChangeLensProvider(documents);
    context.subscriptions.push(
        logger,
        channel,
        services,
        provider,
        treeView,
        documents,
        vscode.workspace.registerTextDocumentContentProvider(LevelDocumentProvider.SCHEME, documents),
        lenses,
        vscode.languages.registerCodeLensProvider({ scheme: LevelDocumentProvider.SCHEME }, lenses),
        new ReviewStatusBar(services, FOCUS_COMMAND),
    );

    const activeServices = async (): Promise<ReviewService[]> => {
        const active = services.all().filter(service => service.isActive());
        if (active.length === 0) {
            await vscode.window.showInformationMessage(viewMessage(services.all(), catalog) ?? inactiveMessage(services.all()[0]));
        }
        return active;
    };

    context.subscriptions.push(
        catalog.onDidChange(() => services.sync(catalog.gitProjects())),
        loggedCommand(logger, 'sonara.review.showSummary', () => {
            logger.flush();
            executeShowSummary(output, services.all());
        }),
        loggedCommand(logger, 'sonara.review.checkStorage', async () => {
            logger.flush();
            const running = services.all();
            if (running.length === 0) {
                await executeCheckStorage(output, undefined);
            }
            for (const service of running) {
                await executeCheckStorage(output, reviewDir(service.project));
            }
        }),
        loggedCommand(logger, 'sonara.review.refresh', async () => {
            (await activeServices()).forEach(service => service.requestFullScan());
        }),
        loggedCommand(logger, OPEN_LEVEL_DIFF_COMMAND, async (project: unknown, repoPath: unknown, level: unknown) => {
            const knownLevel = REVIEW_LEVELS.find(candidate => candidate === level) as ReviewLevel | undefined;
            if (typeof project !== 'string' || typeof repoPath !== 'string' || !knownLevel) {
                await vscode.window.showWarningMessage('Sonara Review: the level diff could not be opened, the file or level is unknown.');
                return;
            }
            await opener.openLevelDiff(project, repoPath, knownLevel);
        }),
        loggedCommand(logger, 'sonara.review.openFile', (uri: unknown) =>
            opener.openWorkingFile(uri instanceof vscode.Uri ? uri : undefined)),
        loggedCommand(logger, 'sonara.review.openPreview', (uri: unknown) =>
            executeOpenPreview(uri instanceof vscode.Uri ? uri : undefined)),
        loggedCommand(logger, MOVE_CHANGE_COMMAND, (reference: unknown, direction: unknown) =>
            executeMoveChange(services, documents, reference as ProjectChangeReference | undefined, direction as ChangeMoveDirection)),
        ...CHANGE_AT_CURSOR_COMMANDS.map(([command, direction]) =>
            loggedCommand(logger, command, () => executeMoveChangeAtCursor(services, documents, direction))),
        loggedCommand(logger, 'sonara.review.nextNewChange', () => executeNavigateNewChange(services, provider, opener, 1)),
        loggedCommand(logger, 'sonara.review.previousNewChange', () => executeNavigateNewChange(services, provider, opener, -1)),
        loggedCommand(logger, 'sonara.review.copyPath', (node: unknown, selection: unknown) =>
            executeCopyPaths(services, provider, 'absolute', node as ReviewNode | undefined, selection as ReviewNode[] | undefined)),
        loggedCommand(logger, 'sonara.review.copyRelativePath', (node: unknown, selection: unknown) =>
            executeCopyPaths(services, provider, 'relative', node as ReviewNode | undefined, selection as ReviewNode[] | undefined)),
        loggedCommand(logger, 'sonara.review.revealInOS', (node: unknown) => executeRevealInOS(services, provider, node as ReviewNode | undefined)),
        loggedCommand(logger, 'sonara.review.delete', (node: unknown, selection: unknown) =>
            executeDelete(services, provider, node as ReviewNode | undefined, selection as ReviewNode[] | undefined)),
        loggedCommand(logger, 'sonara.review.showActions', (node: unknown, selection: unknown) =>
            executeShowActions(node as ReviewNode | undefined, selection as ReviewNode[] | undefined)),
        loggedCommand(logger, 'sonara.review.viewAsTree', () => setViewMode('tree')),
        loggedCommand(logger, 'sonara.review.viewAsList', () => setViewMode('list')),
        loggedCommand(logger, 'sonara.review.expandFolder', (node: unknown) => provider.setSubtreeExpanded(node as ReviewNode, true)),
        loggedCommand(logger, 'sonara.review.collapseFolder', (node: unknown) => provider.setSubtreeExpanded(node as ReviewNode, false)),
        ...MOVE_COMMANDS.map(([command, direction]) => loggedCommand(
            logger,
            command,
            (node: unknown, selection: unknown) =>
                executeMoveLevel(services, provider, direction, node as ReviewNode | undefined, selection as ReviewNode[] | undefined),
        )),
    );

    services.sync(catalog.gitProjects());
}
