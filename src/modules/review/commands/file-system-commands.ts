import * as path from 'path';
import * as vscode from 'vscode';
import { ReviewService, inactiveMessage } from '../review-service';
import { ReviewServiceHolder } from '../review-service-holder';
import { ReviewNode } from '../view/review-node';
import { ReviewTreeProvider } from '../view/review-tree-provider';

export type PathKind = 'absolute' | 'relative';

interface PathTarget {
    uri: vscode.Uri;
    isFolder: boolean;
}

const MOVE_TO_TRASH = 'Move to Trash';

function isInside(child: string, parent: string): boolean {
    return child.startsWith(`${parent}${path.sep}`);
}

function selectedTargets(
    service: ReviewService,
    provider: ReviewTreeProvider,
    node: ReviewNode | undefined,
    selection: readonly ReviewNode[] | undefined,
): PathTarget[] {
    if (!node) {
        return [];
    }
    const nodes = selection && selection.includes(node) ? selection : [node];
    const targets: PathTarget[] = [];
    for (const current of nodes) {
        if (current.type === 'file') {
            targets.push({ uri: vscode.Uri.file(service.absolutePath(current.path)), isFolder: false });
        } else if (current.type === 'folder') {
            targets.push({ uri: vscode.Uri.file(provider.absoluteDisplayPath(current.displayPath)), isFolder: true });
        }
    }
    return targets.filter((target, index) =>
        targets.findIndex(other => other.uri.fsPath === target.uri.fsPath) === index
        && !targets.some(other => other.isFolder && isInside(target.uri.fsPath, other.uri.fsPath)));
}

async function activeService(holder: ReviewServiceHolder): Promise<ReviewService | undefined> {
    const service = holder.get();
    if (!service || !service.isActive()) {
        await vscode.window.showInformationMessage(inactiveMessage(service));
        return undefined;
    }
    return service;
}

async function existsOnDisk(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

function deleteQuestion(targets: readonly PathTarget[]): string {
    if (targets.length > 1) {
        return `Are you sure you want to delete the following ${targets.length} items?`;
    }
    const name = path.basename(targets[0].uri.fsPath);
    return targets[0].isFolder ? `Are you sure you want to delete '${name}' and its contents?` : `Are you sure you want to delete '${name}'?`;
}

function deleteDetail(targets: readonly PathTarget[]): string {
    const lines = targets.length > 1 ? targets.map(target => vscode.workspace.asRelativePath(target.uri, false)) : [];
    if (targets.some(target => target.isFolder)) {
        lines.push('A folder is deleted with everything in it, including files that have no changes.');
    }
    lines.push('You can restore from the Trash.');
    return lines.join('\n');
}

export async function executeCopyPaths(
    holder: ReviewServiceHolder,
    provider: ReviewTreeProvider,
    kind: PathKind,
    node: ReviewNode | undefined,
    selection: readonly ReviewNode[] | undefined,
): Promise<void> {
    const service = await activeService(holder);
    const targets = service ? selectedTargets(service, provider, node, selection) : [];
    if (targets.length === 0) {
        return;
    }
    const paths = targets.map(target => kind === 'absolute' ? target.uri.fsPath : vscode.workspace.asRelativePath(target.uri, false));
    await vscode.env.clipboard.writeText(paths.join('\n'));
}

export async function executeRevealInOS(holder: ReviewServiceHolder, provider: ReviewTreeProvider, node: ReviewNode | undefined): Promise<void> {
    const service = await activeService(holder);
    const [target] = service ? selectedTargets(service, provider, node, undefined) : [];
    if (!target) {
        return;
    }
    if (!await existsOnDisk(target.uri)) {
        await vscode.window.showInformationMessage(`Sonara Review: ${vscode.workspace.asRelativePath(target.uri, false)} is not on disk, it is deleted in the working tree.`);
        return;
    }
    await vscode.commands.executeCommand('revealFileInOS', target.uri);
}

export async function executeDelete(
    holder: ReviewServiceHolder,
    provider: ReviewTreeProvider,
    node: ReviewNode | undefined,
    selection: readonly ReviewNode[] | undefined,
): Promise<void> {
    const service = await activeService(holder);
    if (!service) {
        return;
    }
    const present: PathTarget[] = [];
    for (const target of selectedTargets(service, provider, node, selection)) {
        if (await existsOnDisk(target.uri)) {
            present.push(target);
        }
    }
    if (present.length === 0) {
        await vscode.window.showInformationMessage('Sonara Review: the selection is not on disk, it is already deleted in the working tree.');
        return;
    }
    const confirmation = await vscode.window.showWarningMessage(deleteQuestion(present), { modal: true, detail: deleteDetail(present) }, MOVE_TO_TRASH);
    if (confirmation !== MOVE_TO_TRASH) {
        return;
    }
    const failures: string[] = [];
    for (const target of present) {
        try {
            await vscode.workspace.fs.delete(target.uri, { recursive: target.isFolder, useTrash: true });
        } catch (error) {
            failures.push(`${vscode.workspace.asRelativePath(target.uri, false)}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (failures.length > 0) {
        await vscode.window.showErrorMessage(`Sonara Review could not delete ${failures.join('; ')}`);
    }
}
