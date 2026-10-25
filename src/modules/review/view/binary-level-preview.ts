import * as path from 'path';
import * as vscode from 'vscode';
import { MAX_BINARY_COPY_BYTES } from '../frontiers/file-stack';
import { LEVEL_LABELS, LevelDocument, LevelDocumentSideName, ReviewLevel } from '../types';
import { BinarySide, BinarySideContent, buildBinaryDiffHtml } from './binary-diff-html';

const VIEW_TYPE = 'sonara.review.binaryDiff';
const NOT_KEPT = `not kept: accepted before Sonara kept copies of binary files, or larger than ${MAX_BINARY_COPY_BYTES / 1024 / 1024} MB`;

function folderName(repoPath: string): string {
    return repoPath.replace(/[^\w.-]+/g, '-');
}

export class BinaryLevelPreview implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private revision = 0;

    constructor(private readonly root: vscode.Uri) {}

    async clear(): Promise<void> {
        await vscode.workspace.fs.delete(this.root, { recursive: true, useTrash: false }).then(undefined, () => undefined);
    }

    async open(repoPath: string, level: ReviewLevel, document: LevelDocument): Promise<void> {
        const name = path.posix.basename(repoPath);
        const panel = this.revealPanel(`${name} (${LEVEL_LABELS[level]})`);
        this.revision++;
        const sides: [BinarySide, BinarySide] = [
            { label: 'Before', content: await this.sideContent(panel.webview, repoPath, level, 'before', name, document) },
            { label: `After, with ${LEVEL_LABELS[level]}`, content: await this.sideContent(panel.webview, repoPath, level, 'after', name, document) },
        ];
        panel.webview.html = buildBinaryDiffHtml(panel.title, name, sides, panel.webview.cspSource);
    }

    dispose(): void {
        this.panel?.dispose();
    }

    private revealPanel(title: string): vscode.WebviewPanel {
        if (this.panel) {
            this.panel.title = title;
            this.panel.reveal(undefined, true);
            return this.panel;
        }
        const panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            title,
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
            { localResourceRoots: [this.root] },
        );
        panel.onDidDispose(() => {
            if (this.panel === panel) {
                this.panel = undefined;
            }
        });
        this.panel = panel;
        return panel;
    }

    private async sideContent(
        webview: vscode.Webview,
        repoPath: string,
        level: ReviewLevel,
        side: LevelDocumentSideName,
        name: string,
        document: LevelDocument,
    ): Promise<BinarySideContent> {
        const isMissing = side === 'before' ? document.isBeforeMissing : document.isAfterMissing;
        if (isMissing) {
            return { kind: 'note', text: side === 'before' ? `The file is added on the ${LEVEL_LABELS[level]} level.` : `The file is deleted on the ${LEVEL_LABELS[level]} level.` };
        }
        const content = side === 'before' ? document.binaryBefore : document.binaryAfter;
        if (content === undefined) {
            return { kind: 'note', text: `This version was ${NOT_KEPT}.` };
        }
        const target = await this.write(repoPath, level, side, name, content);
        const source = webview.asWebviewUri(target).with({ query: `revision=${this.revision}` });
        return { kind: 'file', source: source.toString(), bytes: content.length };
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
