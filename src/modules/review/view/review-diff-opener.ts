import * as path from 'path';
import * as vscode from 'vscode';
import { ReviewService } from '../review-service';
import { ReviewServiceHolder } from '../review-service-holder';
import { LEVEL_LABELS, ReviewLevel } from '../types';
import { BinaryLevelPreview } from './binary-level-preview';
import { DiffCodeLensPrompt } from './diff-code-lens-prompt';
import { LevelDocumentProvider } from './level-document-provider';

function selectionAt(line: number): vscode.Range {
    const position = new vscode.Position(Math.max(line, 0), 0);
    return new vscode.Range(position, position);
}

export class ReviewDiffOpener {
    constructor(
        private readonly documents: LevelDocumentProvider,
        private readonly codeLensPrompt: DiffCodeLensPrompt,
        private readonly holder: ReviewServiceHolder,
        private readonly binaryPreview: BinaryLevelPreview,
    ) {}

    async openLevelDiff(repoPath: string, level: ReviewLevel, revealLine?: number): Promise<void> {
        if (this.holder.get()?.getFile(repoPath)?.scanned.kind === 'opaque') {
            const document = await this.documents.document(repoPath, level);
            if (document) {
                await this.binaryPreview.open(repoPath, level, document);
                return;
            }
        }
        const before = LevelDocumentProvider.uriFor({ repoPath, level, side: 'before' });
        const after = LevelDocumentProvider.uriFor({ repoPath, level, side: 'after' });
        const title = `${path.posix.basename(repoPath)} (${LEVEL_LABELS[level]})`;
        const line = revealLine ?? await this.documents.firstChangeLine(repoPath, level);
        const single = await this.documents.sideToShow(repoPath, level);
        if (single) {
            const uri = single === 'after' ? after : before;
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document, { selection: selectionAt(line), preview: true, preserveFocus: true });
            return;
        }
        await vscode.commands.executeCommand('vscode.diff', before, after, title, { selection: selectionAt(line), preview: true, preserveFocus: true });
        void this.codeLensPrompt.showIfNeeded();
    }

    async openWorkingFile(service: ReviewService, uri: vscode.Uri | undefined): Promise<void> {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        const address = target ? LevelDocumentProvider.parse(target) : null;
        if (!address) {
            await vscode.window.showInformationMessage('Sonara Review: Open File works from a level diff opened in the Review panel.');
            return;
        }
        const line = await service.firstWorkingLine(address.repoPath, address.level);
        const fileUri = vscode.Uri.file(service.absolutePath(address.repoPath));
        await vscode.commands.executeCommand('vscode.open', fileUri, { selection: selectionAt(line), preview: false });
    }
}
