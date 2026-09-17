import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeMoveResult, LevelChangeReference, inactiveMessage } from '../review-service';
import { ReviewServiceHolder } from '../review-service-holder';
import { LEVEL_LABELS, LevelChange } from '../types';
import { ChangeMoveDirection } from '../view/level-change-lens-provider';
import { LevelDocumentProvider } from '../view/level-document-provider';
import { ReviewDiffOpener } from '../view/review-diff-opener';
import { ReviewTreeProvider } from '../view/review-tree-provider';
import { pickLevel, shiftedLevel } from './move-level-command';

export type NavigationStep = 1 | -1;

function changeAtLine(changes: readonly LevelChange[], line: number): LevelChange | undefined {
    const containing = changes.filter(change => line >= change.line && line < change.line + Math.max(change.lineCount, 1));
    return containing.length === 1 ? containing[0] : undefined;
}

async function report(result: ChangeMoveResult, reference: LevelChangeReference, documents: LevelDocumentProvider): Promise<void> {
    const { failures, refusals, stalePaths } = result.report;
    if (stalePaths.length > 0) {
        documents.refreshPath(reference.repoPath);
        await vscode.window.showInformationMessage(
            `Sonara Review: ${reference.repoPath} changed after this diff was built. Nothing was moved, the diff is being refreshed.`,
        );
        return;
    }
    if (failures.length > 0) {
        await vscode.window.showErrorMessage(
            `Sonara Review could not update the git stage for ${failures.map(failure => `${failure.path}: ${failure.message}`).join('; ')}`,
        );
        return;
    }
    if (refusals.length > 0) {
        await vscode.window.showWarningMessage(`Sonara Review did not move the change. ${refusals.join(' ')}`);
        return;
    }
    if (result.remainingOnLevel === 0) {
        await vscode.window.showInformationMessage(
            `Sonara Review: no changes left on the ${LEVEL_LABELS[reference.level]} level in ${path.posix.basename(reference.repoPath)}.`,
        );
    }
}

export async function executeMoveChange(
    holder: ReviewServiceHolder,
    documents: LevelDocumentProvider,
    reference: LevelChangeReference | undefined,
    direction: ChangeMoveDirection,
): Promise<void> {
    const service = holder.get();
    if (!service || !service.isActive()) {
        await vscode.window.showInformationMessage(inactiveMessage(service));
        return;
    }
    if (!reference) {
        await vscode.window.showInformationMessage('Sonara Review: this command needs a change from a level diff.');
        return;
    }
    const target = direction === 'pick' ? await pickLevel(reference.level) : shiftedLevel(reference.level, direction);
    if (!target) {
        if (direction !== 'pick') {
            await vscode.window.showInformationMessage(`Sonara Review: there is no level ${direction === 'up' ? 'above' : 'below'} ${LEVEL_LABELS[reference.level]}.`);
        }
        return;
    }
    if (target === reference.level) {
        await vscode.window.showInformationMessage(`Sonara Review: the change is already on the ${LEVEL_LABELS[target]} level.`);
        return;
    }
    await report(await service.moveChange(reference, target), reference, documents);
}

export async function executeMoveChangeAtCursor(
    holder: ReviewServiceHolder,
    documents: LevelDocumentProvider,
    direction: ChangeMoveDirection,
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const address = editor ? LevelDocumentProvider.parse(editor.document.uri) : null;
    if (!editor || !address) {
        await vscode.window.showInformationMessage('Sonara Review: open a level diff from the Review panel and place the cursor on a change.');
        return;
    }
    if (address.side !== 'after') {
        await vscode.window.showInformationMessage('Sonara Review: place the cursor in the right side of the level diff.');
        return;
    }
    const shown = documents.shownDocument(editor.document.uri);
    const change = shown ? changeAtLine(shown.changes, editor.selection.active.line) : undefined;
    if (!shown || !change) {
        await vscode.window.showInformationMessage(`Sonara Review: the cursor is not on exactly one change of the ${LEVEL_LABELS[address.level]} level. Place it on the lines of the change you want to move.`);
        return;
    }
    await executeMoveChange(holder, documents, {
        repoPath: address.repoPath,
        level: address.level,
        changeId: change.id,
        generation: shown.generation,
    }, direction);
}

export async function executeNavigateNewChange(
    holder: ReviewServiceHolder,
    provider: ReviewTreeProvider,
    opener: ReviewDiffOpener,
    step: NavigationStep,
): Promise<void> {
    const service = holder.get();
    if (!service || !service.isActive()) {
        await vscode.window.showInformationMessage(inactiveMessage(service));
        return;
    }
    const files = provider.orderedFiles('new');
    if (files.length === 0) {
        await vscode.window.showInformationMessage('Sonara Review: there are no new changes.');
        return;
    }
    const editor = vscode.window.activeTextEditor;
    const address = editor ? LevelDocumentProvider.parse(editor.document.uri) : null;
    const currentPath = address ? address.repoPath : editor ? service.repoPathForFile(editor.document.uri.fsPath) : null;
    const isNewCoordinates = address ? address.level === 'new' && address.side === 'after' : editor !== undefined;
    const cursor = editor && isNewCoordinates ? editor.selection.active.line : step > 0 ? -1 : Number.MAX_SAFE_INTEGER;
    const currentIndex = currentPath ? files.indexOf(currentPath) : -1;

    if (currentIndex >= 0 && currentPath) {
        const lines = await newChangeLines(service.levelDocument.bind(service), currentPath);
        const inFile = step > 0 ? lines.find(line => line > cursor) : [...lines].reverse().find(line => line < cursor);
        if (inFile !== undefined) {
            await opener.openLevelDiff(currentPath, 'new', inFile);
            return;
        }
    }
    const startIndex = currentIndex >= 0 ? currentIndex : step > 0 ? -1 : 0;
    for (let offset = 1; offset <= files.length; offset++) {
        const candidate = files[(startIndex + step * offset + files.length * offset) % files.length];
        const lines = await newChangeLines(service.levelDocument.bind(service), candidate);
        if (lines.length > 0) {
            await opener.openLevelDiff(candidate, 'new', step > 0 ? lines[0] : lines[lines.length - 1]);
            return;
        }
    }
    await vscode.window.showInformationMessage('Sonara Review: there are no new changes.');
}

async function newChangeLines(
    buildDocument: (repoPath: string, level: 'new') => Promise<{ changes: LevelChange[] } | null>,
    repoPath: string,
): Promise<number[]> {
    const document = await buildDocument(repoPath, 'new');
    return (document?.changes ?? []).map(change => change.line).sort((a, b) => a - b);
}
