import * as vscode from 'vscode';
import { LevelDocumentProvider } from '../view/level-document-provider';

export async function executeOpenPreview(uri: vscode.Uri | undefined): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || !LevelDocumentProvider.parse(target)) {
        await vscode.window.showInformationMessage('Sonara Review: Open Preview works from a level diff opened in the Review panel.');
        return;
    }
    await vscode.commands.executeCommand('markdown.showPreview', target);
}
