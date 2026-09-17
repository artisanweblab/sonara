import * as vscode from 'vscode';
import { ActiveProject } from '../../shared/active-project';
import { withTimestamps } from '../../shared/timestamped-channel';
import { OutputReviewLogger } from './logging/output-review-logger';
import { ReviewLogger } from './logging/review-logger';
import { executeMoveChange, executeMoveChangeAtCursor, executeNavigateNewChange } from './commands/change-commands';
import { MoveDirection, executeMoveLevel } from './commands/move-level-command';
import { executeShowSummary } from './commands/show-summary-command';
import { ReviewService, inactiveMessage } from './review-service';
import { ReviewServiceHolder } from './review-service-holder';
import { REVIEW_LEVELS, ReviewLevel } from './types';
import { LevelChangeReference } from './review-service';
import { ChangeMoveDirection, LevelChangeLensProvider, MOVE_CHANGE_COMMAND } from './view/level-change-lens-provider';
import { DiffCodeLensPrompt } from './view/diff-code-lens-prompt';
import { LevelDocumentProvider } from './view/level-document-provider';
import { ReviewDiffOpener } from './view/review-diff-opener';
import { ReviewNode } from './view/review-node';
import { OPEN_LEVEL_DIFF_COMMAND, ReviewTreeProvider } from './view/review-tree-provider';
import { ReviewStatusBar } from './view/review-status-bar';

const FOCUS_COMMAND = `${ReviewTreeProvider.VIEW_ID}.focus`;

const MOVE_COMMANDS: ReadonlyArray<[string, MoveDirection]> = [
    ['sonara.review.moveUp', 'up'],
    ['sonara.review.moveDown', 'down'],
    ['sonara.review.moveToLevel', 'pick'],
    ['sonara.review.moveAllUp', 'up'],
    ['sonara.review.moveAllDown', 'down'],
    ['sonara.review.moveAllToLevel', 'pick'],
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

function loggedCommand(logger: ReviewLogger, command: string, handler: (...args: unknown[]) => unknown): vscode.Disposable {
    return vscode.commands.registerCommand(command, async (...args: unknown[]) => {
        logger.info(`Command ${command} ${describeArguments(args)}`);
        try {
            await handler(...args);
        } catch (error) {
            logger.error(`Command ${command} failed`, error);
            await vscode.window.showErrorMessage(`Sonara Review: ${command} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
}

export function registerReviewModule(context: vscode.ExtensionContext, activeProject: ActiveProject): void {
    const channel = vscode.window.createOutputChannel('Sonara Review');
    const output = withTimestamps(channel);
    let isDebugLog = vscode.workspace.getConfiguration('sonara.review').get<boolean>('debugLog', false);
    const logger = new OutputReviewLogger(channel, () => isDebugLog);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('sonara.review.debugLog')) {
            isDebugLog = vscode.workspace.getConfiguration('sonara.review').get<boolean>('debugLog', false);
        }
    }));
    const holder = new ReviewServiceHolder();
    const provider = new ReviewTreeProvider(holder);
    const treeView = vscode.window.createTreeView(ReviewTreeProvider.VIEW_ID, {
        treeDataProvider: provider,
        canSelectMany: true,
        showCollapseAll: true,
    });
    const updateMessage = (): void => {
        const service = holder.get();
        treeView.message = service && !service.isActive() && service.getIdleReason() ? inactiveMessage(service) : undefined;
    };
    context.subscriptions.push(holder.onDidChange(updateMessage));
    const documents = new LevelDocumentProvider(holder);
    const opener = new ReviewDiffOpener(documents, new DiffCodeLensPrompt(context.globalState, logger));
    const lenses = new LevelChangeLensProvider(documents);
    context.subscriptions.push(
        logger,
        channel,
        holder,
        provider,
        treeView,
        documents,
        vscode.workspace.registerTextDocumentContentProvider(LevelDocumentProvider.SCHEME, documents),
        lenses,
        vscode.languages.registerCodeLensProvider({ scheme: LevelDocumentProvider.SCHEME }, lenses),
        new ReviewStatusBar(holder, FOCUS_COMMAND),
    );

    const startFor = (folder: vscode.WorkspaceFolder | undefined): void => {
        if (!folder) {
            holder.set(undefined);
            return;
        }
        logger.info(`Active project: ${folder.uri.fsPath}`);
        const service = new ReviewService(folder, logger);
        holder.set(service);
        service.start().catch(error => {
            logger.error('Review failed to start', error);
        });
    };

    const withService = async (action: (service: ReviewService) => Promise<void> | void): Promise<void> => {
        const service = holder.get();
        if (!service || !service.isActive()) {
            await vscode.window.showInformationMessage(inactiveMessage(service));
            return;
        }
        await action(service);
    };

    context.subscriptions.push(
        activeProject.onDidChange(folder => startFor(folder)),
        loggedCommand(logger, 'sonara.review.showSummary', () => {
            logger.flush();
            executeShowSummary(output, holder.get());
        }),
        loggedCommand(logger, 'sonara.review.refresh', () => withService(service => service.requestFullScan())),
        loggedCommand(logger, OPEN_LEVEL_DIFF_COMMAND, async (repoPath: unknown, level: unknown) => {
            const knownLevel = REVIEW_LEVELS.find(candidate => candidate === level) as ReviewLevel | undefined;
            if (typeof repoPath !== 'string' || !knownLevel) {
                await vscode.window.showWarningMessage('Sonara Review: the level diff could not be opened, the file or level is unknown.');
                return;
            }
            await opener.openLevelDiff(repoPath, knownLevel);
        }),
        loggedCommand(logger, 'sonara.review.openFile', (uri: unknown) =>
            withService(service => opener.openWorkingFile(service, uri instanceof vscode.Uri ? uri : undefined))),
        loggedCommand(logger, MOVE_CHANGE_COMMAND, (reference: unknown, direction: unknown) =>
            executeMoveChange(holder, documents, reference as LevelChangeReference | undefined, direction as ChangeMoveDirection)),
        ...CHANGE_AT_CURSOR_COMMANDS.map(([command, direction]) =>
            loggedCommand(logger, command, () => executeMoveChangeAtCursor(holder, documents, direction))),
        loggedCommand(logger, 'sonara.review.nextNewChange', () => executeNavigateNewChange(holder, provider, opener, 1)),
        loggedCommand(logger, 'sonara.review.previousNewChange', () => executeNavigateNewChange(holder, provider, opener, -1)),
        ...MOVE_COMMANDS.map(([command, direction]) => loggedCommand(
            logger,
            command,
            (node: unknown, selection: unknown) =>
                executeMoveLevel(holder, provider, direction, node as ReviewNode | undefined, selection as ReviewNode[] | undefined),
        )),
    );

    startFor(activeProject.get());
}
