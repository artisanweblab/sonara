import * as path from 'path';
import * as vscode from 'vscode';

import { TranscriptStore } from './transcript-store';
import { buildTranscriptsPanelHtml } from './panel-html';
import { ActiveProject } from '../../../../shared/active-project';
import { transcriptsDir } from '../../../../shared/project-layout';
import { openInEditor } from '../../../../shared/fs-utils';

type PanelMessage =
    | { type: 'ready' }
    | { type: 'open'; id: string }
    | { type: 'openPreview'; id: string }
    | { type: 'reveal'; id: string }
    | { type: 'copyText'; id: string }
    | { type: 'copyPath'; id: string }
    | { type: 'delete'; id: string };

export class VoiceTranscriptsPanel implements vscode.WebviewViewProvider, vscode.Disposable {
    private view: vscode.WebviewView | null = null;
    private store: TranscriptStore;
    private secondaryColumn: vscode.ViewColumn | undefined;
    private readonly storeDisposables: vscode.Disposable[] = [];
    private readonly panelDisposables: vscode.Disposable[] = [];

    constructor(
        store: TranscriptStore,
        private readonly extensionUri: vscode.Uri,
        private readonly activeProject: ActiveProject,
    ) {
        this.store = store;
        this.attachStoreListeners();
        this.panelDisposables.push(
            activeProject.onDidChange(folder => {
                const newStore = new TranscriptStore(folder ? transcriptsDir(folder) : null);
                this.updateStore(newStore);
            }),
        );
    }

    getCurrentStore(): TranscriptStore {
        return this.store;
    }

    updateStore(store: TranscriptStore): void {
        this.storeDisposables.forEach(d => d.dispose());
        this.storeDisposables.length = 0;
        this.store.dispose();
        this.store = store;
        this.attachStoreListeners();
        this.refresh();
    }

    private attachStoreListeners(): void {
        this.storeDisposables.push(this.store.onChanged(() => this.refresh()));
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.html = buildTranscriptsPanelHtml();

        webviewView.webview.onDidReceiveMessage((msg: PanelMessage) => {
            this.handleMessage(msg);
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.refresh();
            }
        });

        this.refresh();
    }

    private fullPath(id: string): string {
        return path.join(this.store.storageDir ?? '', id);
    }

    /**
     * Returns true when id is safe: no path separators, no "..", not absolute.
     * Also verifies the id exists in the current store listing.
     */
    private async isKnownId(id: string): Promise<boolean> {
        if (
            id.includes('/') ||
            id.includes('\\') ||
            id.includes('..') ||
            path.isAbsolute(id)
        ) {
            return false;
        }
        const items = await this.store.list();
        return items.some(item => item.id === id);
    }

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
            return true;
        } catch {
            return false;
        }
    }

    private async handleMessage(msg: PanelMessage): Promise<void> {
        switch (msg.type) {
            case 'ready':
                await this.refresh();
                break;

            case 'open': {
                if (!(await this.isKnownId(msg.id))) {
                    break;
                }
                const openPath = this.fullPath(msg.id);
                if (!(await this.fileExists(openPath))) {
                    await vscode.window.showInformationMessage(`Transcript "${msg.id}" no longer exists.`);
                    await this.forceRefresh();
                    break;
                }
                try {
                    await openInEditor(openPath);
                } catch {
                    await vscode.window.showInformationMessage(`Could not open transcript "${msg.id}".`);
                }
                break;
            }

            case 'openPreview': {
                if (!(await this.isKnownId(msg.id))) {
                    break;
                }
                const previewPath = this.fullPath(msg.id);
                if (!(await this.fileExists(previewPath))) {
                    await vscode.window.showInformationMessage(`Transcript "${msg.id}" no longer exists.`);
                    await this.forceRefresh();
                    break;
                }
                try {
                    await this.openMarkdownPreviewReusing(vscode.Uri.file(previewPath));
                } catch {
                    await vscode.window.showInformationMessage(`Could not preview transcript "${msg.id}".`);
                }
                break;
            }

            case 'reveal': {
                if (!(await this.isKnownId(msg.id))) {
                    break;
                }
                const revealPath = this.fullPath(msg.id);
                if (!(await this.fileExists(revealPath))) {
                    await vscode.window.showInformationMessage(`Transcript "${msg.id}" no longer exists.`);
                    await this.forceRefresh();
                    break;
                }
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(revealPath));
                break;
            }

            case 'copyText': {
                if (!(await this.isKnownId(msg.id))) {
                    break;
                }
                const copyTextPath = this.fullPath(msg.id);
                if (!(await this.fileExists(copyTextPath))) {
                    await vscode.window.showInformationMessage(`Transcript "${msg.id}" no longer exists.`);
                    await this.forceRefresh();
                    break;
                }
                try {
                    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(copyTextPath));
                    await vscode.env.clipboard.writeText(Buffer.from(bytes).toString('utf8'));
                    this.view?.webview.postMessage({ type: 'copied', id: msg.id, kind: 'text' });
                } catch {
                    await vscode.window.showInformationMessage(`Could not read transcript "${msg.id}".`);
                }
                break;
            }

            case 'copyPath': {
                if (!(await this.isKnownId(msg.id))) {
                    break;
                }
                const copyFilePath = this.fullPath(msg.id);
                if (!(await this.fileExists(copyFilePath))) {
                    await vscode.window.showInformationMessage(`Transcript "${msg.id}" no longer exists.`);
                    await this.forceRefresh();
                    break;
                }
                await vscode.env.clipboard.writeText(copyFilePath);
                this.view?.webview.postMessage({ type: 'copied', id: msg.id, kind: 'path' });
                break;
            }

            case 'delete': {
                if (!(await this.isKnownId(msg.id))) {
                    break;
                }
                const confirm = await vscode.window.showWarningMessage(
                    `Delete transcript "${msg.id}"?`,
                    { modal: true },
                    'Delete',
                );
                if (confirm === 'Delete') {
                    await this.store.delete(msg.id);
                }
                break;
            }
        }
    }

    private resolveSecondaryColumn(): vscode.ViewColumn {
        if (this.secondaryColumn !== undefined) {
            const stillOpen = vscode.window.tabGroups.all.some(
                g => g.viewColumn === this.secondaryColumn && g.tabs.length > 0,
            );
            if (stillOpen) {
                return this.secondaryColumn;
            }
            this.secondaryColumn = undefined;
        }
        return vscode.ViewColumn.Beside;
    }

    private async openMarkdownPreviewReusing(uri: vscode.Uri): Promise<void> {
        const column = this.resolveSecondaryColumn();
        await vscode.commands.executeCommand('vscode.openWith', uri, 'vscode.markdown.preview.editor', column);
        if (column === vscode.ViewColumn.Beside) {
            this.secondaryColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
        }
    }

    public async forceRefresh(): Promise<void> {
        this.store.refresh();
        await this.refresh();
    }

    private async refresh(): Promise<void> {
        if (!this.view?.visible) {
            return;
        }
        if (!this.activeProject.get()) {
            this.view.webview.postMessage({ type: 'noWorkspace' });
            return;
        }
        const items = await this.store.list();
        this.view.webview.postMessage({ type: 'items', items });
    }

    dispose(): void {
        this.storeDisposables.forEach(d => d.dispose());
        this.panelDisposables.forEach(d => d.dispose());
        this.store.dispose();
    }
}
