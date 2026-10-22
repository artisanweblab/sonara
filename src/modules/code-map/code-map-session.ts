import * as path from 'path';
import * as vscode from 'vscode';
import { CodeMapScanner, FileStats } from './code-map-scanner';
import { NotGitRepositoryError } from './git-files';

const DEBOUNCE_MS = 500;
const GIT_STATE_FILES = '{index,HEAD,packed-refs,refs/heads/**}';

export type CodeMapState = { kind: 'files'; files: FileStats[] } | { kind: 'problem'; message: string };

function isInsideGitFolder(folderPath: string, fsPath: string): boolean {
    return path.relative(folderPath, fsPath).split(path.sep).includes('.git');
}

export class CodeMapSession implements vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<CodeMapState>();
    readonly onDidChange = this.emitter.event;

    private readonly scanner: CodeMapScanner;
    private readonly disposables: vscode.Disposable[] = [];
    private timer: NodeJS.Timeout | undefined;
    private isScanning = false;
    private isScanPending = false;
    private isGitWatched = false;
    private isDisposed = false;

    constructor(readonly folder: vscode.WorkspaceFolder) {
        this.scanner = new CodeMapScanner(folder.uri.fsPath);
    }

    start(): void {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, '**/*'));
        const onUri = (uri: vscode.Uri): void => {
            if (!this.isGitWatched || !isInsideGitFolder(this.folder.uri.fsPath, uri.fsPath)) {
                this.requestScan();
            }
        };
        this.disposables.push(watcher, watcher.onDidCreate(onUri), watcher.onDidChange(onUri), watcher.onDidDelete(onUri));
        void this.scan();
    }

    requestScan(): void {
        if (this.isDisposed) {
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => void this.scan(), DEBOUNCE_MS);
    }

    dispose(): void {
        this.isDisposed = true;
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.disposables.forEach(disposable => disposable.dispose());
        this.emitter.dispose();
    }

    private async scan(): Promise<void> {
        this.timer = undefined;
        if (this.isScanning) {
            this.isScanPending = true;
            return;
        }
        this.isScanning = true;
        try {
            const files = await this.scanner.scan();
            await this.watchGitState();
            this.publish({ kind: 'files', files });
        } catch (error) {
            this.publish({
                kind: 'problem',
                message: error instanceof NotGitRepositoryError
                    ? 'Code Map shows files under git, and no git repository was found in this project.'
                    : `Code Map could not read the project: ${error instanceof Error ? error.message : String(error)}`,
            });
        } finally {
            this.isScanning = false;
        }
        if (this.isScanPending) {
            this.isScanPending = false;
            await this.scan();
        }
    }

    private async watchGitState(): Promise<void> {
        if (this.isGitWatched) {
            return;
        }
        this.isGitWatched = true;
        for (const directory of await this.scanner.gitDirectories()) {
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(directory), GIT_STATE_FILES));
            this.disposables.push(
                watcher,
                watcher.onDidCreate(() => this.requestScan()),
                watcher.onDidChange(() => this.requestScan()),
                watcher.onDidDelete(() => this.requestScan()),
            );
        }
    }

    private publish(state: CodeMapState): void {
        if (!this.isDisposed) {
            this.emitter.fire(state);
        }
    }
}
