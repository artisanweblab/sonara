import * as path from 'path';
import * as vscode from 'vscode';
import { selectedNodes } from '../../../shared/file-actions';
import { inactiveMessage } from '../review-service';
import { ReviewServices } from '../review-services';
import { ReviewNode } from '../view/review-node';
import { collectFiles } from '../view/review-tree-builder';

const REVERT = 'Revert';
const LISTED_FILES = 10;

function confirmationTitle(repoPaths: readonly string[]): string {
    return repoPaths.length === 1 ? `Revert all changes in '${path.posix.basename(repoPaths[0])}'?` : `Revert all changes in ${repoPaths.length} files?`;
}

function confirmationDetail(repoPaths: readonly string[]): string {
    const listed = repoPaths.slice(0, LISTED_FILES);
    const lines = repoPaths.length > 1 ? listed : [];
    if (repoPaths.length > LISTED_FILES) {
        lines.push(`and ${repoPaths.length - LISTED_FILES} more`);
    }
    lines.push('The changes on every level are discarded, Staged Changes included. Files that exist in HEAD are restored from it, new files are moved to the Trash. This cannot be undone.');
    return lines.join('\n');
}

export async function executeRevert(
    services: ReviewServices,
    node: ReviewNode | undefined,
    selection: readonly ReviewNode[] | undefined,
): Promise<void> {
    const byProject = new Map<string, Set<string>>();
    for (const file of selectedNodes(node, selection).flatMap(current => collectFiles(current))) {
        byProject.set(file.project, (byProject.get(file.project) ?? new Set<string>()).add(file.path));
    }
    if (byProject.size === 0) {
        await vscode.window.showInformationMessage('Sonara Review: select a file or a folder to revert.');
        return;
    }
    for (const project of byProject.keys()) {
        const service = services.get(project);
        if (!service || !service.isActive()) {
            await vscode.window.showInformationMessage(inactiveMessage(service));
            return;
        }
    }
    const repoPaths = Array.from(byProject.values()).flatMap(paths => Array.from(paths));
    const answer = await vscode.window.showWarningMessage(confirmationTitle(repoPaths), { modal: true, detail: confirmationDetail(repoPaths) }, REVERT);
    if (answer !== REVERT) {
        return;
    }
    const failures: string[] = [];
    for (const [project, paths] of byProject) {
        const report = await services.get(project)?.revertFiles(Array.from(paths));
        failures.push(...(report?.failures ?? []));
    }
    if (failures.length > 0) {
        await vscode.window.showErrorMessage(`Sonara Review could not revert ${failures.join('; ')}`);
    }
}
