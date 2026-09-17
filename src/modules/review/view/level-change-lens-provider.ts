import * as vscode from 'vscode';
import { LevelChangeReference } from '../review-service';
import { LevelChange, REVIEW_LEVELS, ReviewLevel, reviewLevelRank } from '../types';
import { LevelDocumentProvider } from './level-document-provider';

export const MOVE_CHANGE_COMMAND = 'sonara.review.moveChange';

export type ChangeMoveDirection = 'up' | 'down' | 'pick';

export class LevelChangeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.emitter.event;
    private readonly subscription: vscode.Disposable;

    constructor(private readonly documents: LevelDocumentProvider) {
        this.subscription = vscode.Disposable.from(
            documents.onDidChange(() => this.emitter.fire()),
            documents.onDidBuild(() => this.emitter.fire()),
        );
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const address = LevelDocumentProvider.parse(document.uri);
        const shown = this.documents.shownDocument(document.uri);
        if (!address || address.side !== 'after' || !shown) {
            return [];
        }
        const lenses: vscode.CodeLens[] = [];
        for (const change of shown.changes) {
            const reference: LevelChangeReference = {
                repoPath: address.repoPath,
                level: address.level,
                changeId: change.id,
                generation: shown.generation,
            };
            const range = this.rangeFor(document, change);
            lenses.push(...this.lensesFor(range, reference, address.level, change.label));
        }
        return lenses;
    }

    private lensesFor(range: vscode.Range, reference: LevelChangeReference, level: ReviewLevel, label: string | null): vscode.CodeLens[] {
        const rank = reviewLevelRank(level);
        const lenses: vscode.CodeLens[] = [];
        if (label) {
            lenses.push(new vscode.CodeLens(range, { title: label, command: '' }));
        }
        if (rank < REVIEW_LEVELS.length - 1) {
            lenses.push(new vscode.CodeLens(range, {
                title: 'Move Up',
                command: MOVE_CHANGE_COMMAND,
                arguments: [reference, 'up'],
            }));
        }
        if (rank > 0) {
            lenses.push(new vscode.CodeLens(range, {
                title: 'Move Down',
                command: MOVE_CHANGE_COMMAND,
                arguments: [reference, 'down'],
            }));
        }
        lenses.push(new vscode.CodeLens(range, {
            title: 'Move to Level...',
            command: MOVE_CHANGE_COMMAND,
            arguments: [reference, 'pick'],
        }));
        return lenses;
    }

    private rangeFor(document: vscode.TextDocument, change: LevelChange): vscode.Range {
        const line = Math.max(0, Math.min(change.line, document.lineCount - 1));
        return new vscode.Range(line, 0, line, 0);
    }

    dispose(): void {
        this.subscription.dispose();
        this.emitter.dispose();
    }
}
