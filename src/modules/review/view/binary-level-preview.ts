import * as path from 'path';
import * as vscode from 'vscode';
import { MAX_BINARY_COPY_BYTES } from '../frontiers/file-stack';
import { LEVEL_LABELS, LevelDocument, LevelDocumentSideName, ReviewLevel } from '../types';

function folderName(repoPath: string): string {
    return repoPath.replace(/[^\w.-]+/g, '-');
}

export class BinaryLevelPreview {
    constructor(private readonly root: vscode.Uri) {}

    async clear(): Promise<void> {
        await vscode.workspace.fs.delete(this.root, { recursive: true, useTrash: false }).then(undefined, () => undefined);
    }

    async open(repoPath: string, level: ReviewLevel, document: LevelDocument): Promise<void> {
        const name = path.posix.basename(repoPath);
        const before = document.isBeforeMissing ? null : document.binaryBefore;
        const after = document.isAfterMissing ? null : document.binaryAfter;
        if (before === undefined || after === undefined) {
            const kept = before === undefined ? after : before;
            const keptSide: LevelDocumentSideName = before === undefined ? 'after' : 'before';
            const lost = before === undefined && after === undefined ? 'neither version was' : `the ${before === undefined ? 'earlier' : 'later'} version was not`;
            const reason = `accepted before Sonara kept copies of binary files, or larger than ${MAX_BINARY_COPY_BYTES / 1024 / 1024} MB`;
            void vscode.window.showInformationMessage(`Sonara Review: on the ${LEVEL_LABELS[level]} level ${lost} kept for ${name} (${reason})${kept ? `, only the ${keptSide === 'after' ? 'later' : 'earlier'} version is shown` : ''}.`);
            if (kept) {
                await vscode.commands.executeCommand('vscode.open', await this.write(repoPath, level, keptSide, name, kept), { preview: true });
            }
            return;
        }
        if (!before && !after) {
            await vscode.window.showInformationMessage(`Sonara Review: ${name} has no content on the ${LEVEL_LABELS[level]} level.`);
            return;
        }
        if (!before || !after) {
            const only = after ?? before;
            if (only) {
                await vscode.commands.executeCommand('vscode.open', await this.write(repoPath, level, after ? 'after' : 'before', name, only), { preview: true });
            }
            return;
        }
        await vscode.commands.executeCommand('vscode.open', await this.write(repoPath, level, 'before', name, before), { preview: false });
        await vscode.commands.executeCommand(
            'vscode.open',
            await this.write(repoPath, level, 'after', name, after),
            { preview: false, viewColumn: vscode.ViewColumn.Beside },
        );
    }

    private async write(
        repoPath: string,
        level: ReviewLevel,
        side: LevelDocumentSideName,
        name: string,
        content: Buffer,
    ): Promise<vscode.Uri> {
        const directory = vscode.Uri.joinPath(this.root, folderName(repoPath), level, side);
        await vscode.workspace.fs.createDirectory(directory);
        const target = vscode.Uri.joinPath(directory, name);
        await vscode.workspace.fs.writeFile(target, content);
        return target;
    }
}
