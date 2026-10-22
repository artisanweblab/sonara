import * as vscode from 'vscode';
import { PathKind, PathTarget, copyPaths, distinctTargets, moveToTrash, revealInOS, selectedNodes } from '../../../shared/file-actions';
import { ReviewService, inactiveMessage } from '../review-service';
import { ReviewServiceHolder } from '../review-service-holder';
import { ReviewNode } from '../view/review-node';
import { ReviewTreeProvider } from '../view/review-tree-provider';

function selectedTargets(
    service: ReviewService,
    provider: ReviewTreeProvider,
    node: ReviewNode | undefined,
    selection: readonly ReviewNode[] | undefined,
): PathTarget[] {
    const targets: PathTarget[] = [];
    for (const current of selectedNodes(node, selection)) {
        if (current.type === 'file') {
            targets.push({ uri: vscode.Uri.file(service.absolutePath(current.path)), isFolder: false });
        } else if (current.type === 'folder') {
            targets.push({ uri: vscode.Uri.file(provider.absoluteDisplayPath(current.displayPath)), isFolder: true });
        }
    }
    return distinctTargets(targets);
}

async function activeService(holder: ReviewServiceHolder): Promise<ReviewService | undefined> {
    const service = holder.get();
    if (!service || !service.isActive()) {
        await vscode.window.showInformationMessage(inactiveMessage(service));
        return undefined;
    }
    return service;
}

export async function executeCopyPaths(
    holder: ReviewServiceHolder,
    provider: ReviewTreeProvider,
    kind: PathKind,
    node: ReviewNode | undefined,
    selection: readonly ReviewNode[] | undefined,
): Promise<void> {
    const service = await activeService(holder);
    await copyPaths(service ? selectedTargets(service, provider, node, selection) : [], kind);
}

export async function executeRevealInOS(holder: ReviewServiceHolder, provider: ReviewTreeProvider, node: ReviewNode | undefined): Promise<void> {
    const service = await activeService(holder);
    const [target] = service ? selectedTargets(service, provider, node, undefined) : [];
    await revealInOS(target, `Sonara Review: ${target ? vscode.workspace.asRelativePath(target.uri, false) : ''} is not on disk, it is deleted in the working tree.`);
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
    await moveToTrash(selectedTargets(service, provider, node, selection), {
        source: 'Sonara Review',
        nothingOnDisk: 'Sonara Review: the selection is not on disk, it is already deleted in the working tree.',
        folderNote: 'A folder is deleted with everything in it, including files that have no changes.',
    });
}
