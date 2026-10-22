import * as vscode from 'vscode';
import { SonaraProject } from '../../../../shared/sonara-project';
import { DraftRecord, LogStore } from './log-store';
import { VoiceRecord } from './types';
import { buildPanelHtml } from './panel-html';
import { ActiveProject } from '../../../../shared/active-project';
import { voiceLogFile, ensureDir, voiceLogDir } from '../../../../shared/project-layout';

type PanelMessage =
    | { type: 'copy'; id: string }
    | { type: 'delete'; id: string }
    | { type: 'edit'; id: string; text: string }
    | { type: 'search'; query: string }
    | { type: 'ready' }
    | { type: 'showAllState'; canToggle: boolean; showAll: boolean };

export class VoiceLogPanel implements vscode.WebviewViewProvider, vscode.Disposable {
    private view: vscode.WebviewView | null = null;
    private logStore: LogStore;
    private searchQuery: string = '';
    private readonly storeDisposables: vscode.Disposable[] = [];
    private readonly panelDisposables: vscode.Disposable[] = [];

    constructor(
        logStore: LogStore,
        private readonly extensionUri: vscode.Uri,
        private readonly activeProject: ActiveProject,
        private readonly logStoreFor: (folder: SonaraProject) => LogStore,
    ) {
        this.logStore = logStore;
        this.attachStoreListeners();
        this.panelDisposables.push(
            activeProject.onDidChange(folder => {
                const newStore = folder
                    ? logStoreFor(folder)
                    : new LogStore(null);
                this.updateLogStore(newStore);
            }),
        );
    }

    getCurrentLogStore(): LogStore {
        return this.logStore;
    }

    updateLogStore(logStore: LogStore): void {
        this.storeDisposables.forEach(d => d.dispose());
        this.storeDisposables.length = 0;

        this.logStore = logStore;
        this.attachStoreListeners();
        this.refresh();
    }

    private attachStoreListeners(): void {
        this.storeDisposables.push(
            this.logStore.onRecordAdded(() => this.resetSearchAndRefresh()),
            this.logStore.onRecordUpdated(() => this.refresh()),
            this.logStore.onRecordDeleted(() => this.refresh()),
            this.logStore.onDraftChanged(draft => this.sendDraft(draft)),
        );
    }

    private async resetSearchAndRefresh(): Promise<void> {
        if (this.searchQuery !== '') {
            this.searchQuery = '';
            this.view?.webview.postMessage({ type: 'clearSearch' });
        }
        await this.refresh();
    }

    private sendDraft(draft: DraftRecord | null): void {
        this.view?.webview.postMessage({ type: 'draft', draft });
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

        webviewView.webview.html = buildPanelHtml();

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

    toggleShowAll(): void {
        this.view?.webview.postMessage({ type: 'toggleShowAll' });
    }

    private async handleMessage(msg: PanelMessage): Promise<void> {
        switch (msg.type) {
            case 'ready':
                await this.refresh();
                break;

            case 'copy':
                await this.handleCopy(msg.id);
                break;

            case 'delete': {
                const confirm = await vscode.window.showWarningMessage(
                    'Delete this voice record?',
                    { modal: true },
                    'Delete'
                );
                if (confirm === 'Delete') {
                    await this.logStore.delete(msg.id);
                }
                break;
            }

            case 'edit':
                await this.logStore.update(msg.id, { text: msg.text });
                break;

            case 'search':
                this.searchQuery = msg.query;
                await this.refresh();
                break;

            case 'showAllState':
                vscode.commands.executeCommand('setContext', 'sonara.voice.log.canToggleShowAll', msg.canToggle);
                vscode.commands.executeCommand('setContext', 'sonara.voice.log.showAll', msg.showAll);
                break;
        }
    }

    private async handleCopy(id: string): Promise<void> {
        const record = await this.logStore.get(id);
        if (!record) {
            return;
        }
        await vscode.env.clipboard.writeText(record.text);
        if (record.copied !== true) {
            await this.logStore.update(id, { copied: true });
        }
        this.view?.webview.postMessage({ type: 'copied', id });
    }

    public async forceRefresh(): Promise<void> {
        await this.refresh();
    }

    private async refresh(): Promise<void> {
        if (!this.view?.visible) {
            return;
        }

        const folder = this.activeProject.get();
        if (!folder) {
            this.view.webview.postMessage({ type: 'noWorkspace' });
            return;
        }

        let records: VoiceRecord[];
        if (this.searchQuery.trim()) {
            records = await this.logStore.search(this.searchQuery);
        } else {
            records = await this.logStore.list();
        }

        this.view.webview.postMessage({
            type: 'records',
            records,
            projectName: folder.name,
            totalCount: this.logStore.recordCount,
        });
        this.sendDraft(this.logStore.currentDraft);
    }

    getVoiceLogDir(): string | undefined {
        const folder = this.activeProject.get();
        return folder ? voiceLogDir(folder) : undefined;
    }

    ensureVoiceLogDir(): string | undefined {
        const folder = this.activeProject.get();
        if (!folder) {
            return undefined;
        }
        const dir = voiceLogDir(folder);
        ensureDir(dir);
        return dir;
    }

    dispose(): void {
        this.storeDisposables.forEach(d => d.dispose());
        this.panelDisposables.forEach(d => d.dispose());
    }
}
