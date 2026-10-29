import * as path from 'path';
import * as vscode from 'vscode';

export type PathKind = 'absolute' | 'relative';

export interface PathTarget {
    uri: vscode.Uri;
    isFolder: boolean;
}

const MOVE_TO_TRASH = 'Move to Trash';

function isInside(child: string, parent: string): boolean {
    return child.startsWith(`${parent}${path.sep}`);
}

export function distinctTargets(targets: readonly PathTarget[]): PathTarget[] {
    return targets.filter((target, index) =>
        targets.findIndex(other => other.uri.fsPath === target.uri.fsPath) === index
        && !targets.some(other => other.isFolder && isInside(target.uri.fsPath, other.uri.fsPath)));
}

export function selectedNodes<T>(node: T | undefined, selection: readonly T[] | undefined): readonly T[] {
    if (!node) {
        return [];
    }
    return selection && selection.includes(node) ? selection : [node];
}

export async function existsOnDisk(uri: vscode.Uri): Promise<boolean> {
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

function deleteDetail(targets: readonly PathTarget[], folderNote: string | undefined): string {
    const lines = targets.length > 1 ? targets.map(target => vscode.workspace.asRelativePath(target.uri, false)) : [];
    if (folderNote && targets.some(target => target.isFolder)) {
        lines.push(folderNote);
    }
    lines.push('You can restore from the Trash.');
    return lines.join('\n');
}

export async function copyPaths(targets: readonly PathTarget[], kind: PathKind): Promise<void> {
    if (targets.length === 0) {
        return;
    }
    const paths = targets.map(target => kind === 'absolute' ? target.uri.fsPath : vscode.workspace.asRelativePath(target.uri, false));
    await vscode.env.clipboard.writeText(paths.join('\n'));
}

export async function revealInOS(target: PathTarget | undefined, missingMessage: string): Promise<void> {
    if (!target) {
        return;
    }
    if (!await existsOnDisk(target.uri)) {
        await vscode.window.showInformationMessage(missingMessage);
        return;
    }
    await vscode.commands.executeCommand('revealFileInOS', target.uri);
}

export async function openWithDefaultApp(targets: readonly PathTarget[], missingMessage: string): Promise<void> {
    for (const target of targets.filter(current => !current.isFolder)) {
        if (!await existsOnDisk(target.uri)) {
            await vscode.window.showInformationMessage(missingMessage);
            continue;
        }
        await vscode.env.openExternal(target.uri);
    }
}

export interface TrashMessages {
    source: string;
    nothingOnDisk: string;
    folderNote?: string;
}

export async function moveToTrash(targets: readonly PathTarget[], messages: TrashMessages): Promise<void> {
    const present: PathTarget[] = [];
    for (const target of targets) {
        if (await existsOnDisk(target.uri)) {
            present.push(target);
        }
    }
    if (present.length === 0) {
        await vscode.window.showInformationMessage(messages.nothingOnDisk);
        return;
    }
    const confirmation = await vscode.window.showWarningMessage(deleteQuestion(present), { modal: true, detail: deleteDetail(present, messages.folderNote) }, MOVE_TO_TRASH);
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
        await vscode.window.showErrorMessage(`${messages.source} could not delete ${failures.join('; ')}`);
    }
}
