import * as vscode from 'vscode';
import { PathKind, PathTarget, copyPaths, distinctTargets, moveToTrash, openWithDefaultApp, revealInOS, selectedNodes } from '../../../shared/file-actions';
import { inactiveMessage } from '../review-service';
import { ReviewServices } from '../review-services';
import { ReviewNode } from '../view/review-node';
import { ReviewTreeProvider } from '../view/review-tree-provider';

async function selectedTargets(
    services: ReviewServices,
    provider: ReviewTreeProvider,
    node: ReviewNode | undefined,
    selection: readonly ReviewNode[] | undefined,
): Promise<PathTarget[] | null> {
    const targets: PathTarget[] = [];
    for (const current of selectedNodes(node, selection)) {
        if (current.type !== 'file' && current.type !== 'folder') {
            continue;
        }
        const service = services.get(current.project);
        if (!service || !service.isActive()) {
            await vscode.window.showInformationMessage(inactiveMessage(service));
            return null;
        }
        targets.push(current.type === 'file'
            ? { uri: vscode.Uri.file(service.absolutePath(current.path)), isFolder: false }
            : { uri: vscode.Uri.file(provider.absoluteDisplayPath(current.project, current.displayPath)), isFolder: true });
    }
    return distinctTargets(targets);
}

export async function executeCopyPaths(
    services: ReviewServices,
    provider: ReviewTreeProvider,
    kind: PathKind,
    node: ReviewNode | undefined,
    selection: readonly ReviewNode[] | undefined,
): Promise<void> {
    await copyPaths(await selectedTargets(services, provider, node, selection) ?? [], kind);
}

export async function executeRevealInOS(services: ReviewServices, provider: ReviewTreeProvider, node: ReviewNode | undefined): Promise<void> {
    const targets = await selectedTargets(services, provider, node, undefined);
    if (!targets) {
        return;
    }
    const [target] = targets;
    await revealInOS(target, `Sonara Review: ${target ? vscode.workspace.asRelativePath(target.uri, false) : ''} is not on disk, it is deleted in the working tree.`);
}

export async function executeOpenWithDefaultApp(
    services: ReviewServices,
    provider: ReviewTreeProvider,
    node: ReviewNode | undefined,
    selection: readonly ReviewNode[] | undefined,
): Promise<void> {
    const targets = await selectedTargets(services, provider, node, selection);
    await openWithDefaultApp(targets ?? [], 'Sonara Review: the file is not on disk, it is deleted in the working tree.');
}

export async function executeDelete(
    services: ReviewServices,
    provider: ReviewTreeProvider,
    node: ReviewNode | undefined,
    selection: readonly ReviewNode[] | undefined,
): Promise<void> {
    const targets = await selectedTargets(services, provider, node, selection);
    if (!targets) {
        return;
    }
    await moveToTrash(targets, {
        source: 'Sonara Review',
        nothingOnDisk: 'Sonara Review: the selection is not on disk, it is already deleted in the working tree.',
        folderNote: 'A folder is deleted with everything in it, including files that have no changes.',
    });
}
