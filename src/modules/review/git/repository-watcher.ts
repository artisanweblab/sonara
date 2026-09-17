import * as path from 'path';
import * as vscode from 'vscode';
import { ReviewLogger } from '../logging/review-logger';
import type { API, Change, Repository } from './git-api';
import { loadGitApi } from './git-extension';
import { OPERATION_MARKERS } from './git-repository-state';

const DEBOUNCE_MS = 500;
const STASH_REFERENCES = ['refs/stash', 'logs/refs/stash'];

export interface RepositoryChange {
    isFull: boolean;
    isStashChanged: boolean;
    isRecheckNeeded: boolean;
    paths: string[];
    recordFiles: string[];
}

export type WatcherStart = { gitPath: string } | { reason: string };

function isInside(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function snapshotChanges(repository: Repository): Map<string, string> {
    const snapshot = new Map<string, string>();
    const add = (changes: Change[], group: string): void => {
        for (const change of changes) {
            const key = change.uri.fsPath;
            snapshot.set(key, `${snapshot.get(key) ?? ''}${group}${change.status};`);
        }
    };
    add(repository.state.indexChanges, 'i');
    add(repository.state.workingTreeChanges, 'w');
    add(repository.state.untrackedChanges, 'u');
    add(repository.state.mergeChanges, 'm');
    return snapshot;
}

export class RepositoryWatcher implements vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<RepositoryChange>();
    readonly onDidChange = this.emitter.event;

    private readonly disposables: vscode.Disposable[] = [];
    private readonly repositoryDisposables: vscode.Disposable[] = [];
    private readonly pendingPaths = new Set<string>();
    private readonly pendingRecordFiles = new Set<string>();
    private isFullPending = false;
    private isStashPending = false;
    private isRecheckPending = false;
    private timer: NodeJS.Timeout | undefined;
    private repository: Repository | undefined;
    private lastHead: string | undefined;
    private lastSnapshot = new Map<string, string>();
    private isDisposed = false;

    constructor(
        private readonly folder: vscode.WorkspaceFolder,
        private readonly reviewRoot: string,
        private readonly logger: ReviewLogger,
    ) {}

    async start(): Promise<WatcherStart> {
        this.watchFileSystem();
        this.disposables.push(vscode.window.onDidChangeWindowState(state => {
            if (state.focused) {
                this.isRecheckPending = true;
                this.schedule();
            }
        }));
        return this.attachGitExtension();
    }

    watchGitOperations(gitDir: string, commonDir: string): void {
        const markers = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(gitDir), `{${OPERATION_MARKERS.join(',')}}`),
            true,
            true,
            false,
        );
        const stash = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(commonDir), `{${STASH_REFERENCES.join(',')}}`));
        const onStash = (): void => {
            this.isStashPending = true;
            this.schedule();
        };
        this.disposables.push(
            markers,
            markers.onDidDelete(uri => {
                this.logger.info(`Watcher: git operation marker ${path.basename(uri.fsPath)} removed, full rescan queued`);
                this.isFullPending = true;
                this.schedule();
            }),
            stash,
            stash.onDidCreate(onStash),
            stash.onDidChange(onStash),
            stash.onDidDelete(onStash),
        );
    }

    private watchFileSystem(): void {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, '**/*'));
        const onUri = (uri: vscode.Uri): void => this.onFileSystemEvent(uri.fsPath);
        this.disposables.push(
            watcher,
            watcher.onDidCreate(onUri),
            watcher.onDidChange(onUri),
            watcher.onDidDelete(onUri),
        );
    }

    private onFileSystemEvent(fsPath: string): void {
        if (isInside(fsPath, path.join(this.reviewRoot, 'files')) || isInside(fsPath, path.join(this.reviewRoot, 'dormant'))) {
            this.pendingRecordFiles.add(fsPath);
            this.schedule();
            return;
        }
        if (isInside(fsPath, this.reviewRoot)) {
            return;
        }
        const relative = path.relative(this.folder.uri.fsPath, fsPath);
        if (relative.split(path.sep).includes('.git')) {
            return;
        }
        this.pendingPaths.add(fsPath);
        this.schedule();
    }

    private async attachGitExtension(): Promise<WatcherStart> {
        const loaded = await loadGitApi();
        if ('reason' in loaded) {
            this.logger.info(`Watcher: ${loaded.reason}`);
            return loaded;
        }
        const api = loaded.api;
        if (this.isDisposed) {
            return { reason: 'the review was closed while starting' };
        }
        this.disposables.push(api.onDidOpenRepository(() => this.bindRepository(api)));
        this.disposables.push(api.onDidCloseRepository(() => this.bindRepository(api)));
        this.bindRepository(api);
        return { gitPath: api.git.path };
    }

    private bindRepository(api: API): void {
        const repository = api.getRepository(this.folder.uri) ?? undefined;
        if (repository === this.repository) {
            return;
        }
        this.repositoryDisposables.forEach(d => d.dispose());
        this.repositoryDisposables.length = 0;
        this.repository = repository;
        if (!repository) {
            return;
        }
        this.lastHead = repository.state.HEAD?.commit;
        this.lastSnapshot = snapshotChanges(repository);
        this.repositoryDisposables.push(repository.state.onDidChange(() => this.onRepositoryState(repository)));
    }

    private onRepositoryState(repository: Repository): void {
        const head = repository.state.HEAD?.commit;
        const snapshot = snapshotChanges(repository);
        this.isRecheckPending = true;
        if (head !== this.lastHead) {
            this.logger.info(`Watcher: git extension reports HEAD ${this.lastHead ?? 'none'} -> ${head ?? 'none'}`);
            this.lastHead = head;
            this.lastSnapshot = snapshot;
            this.isFullPending = true;
            this.schedule();
            return;
        }
        const indexed = new Set(repository.state.indexChanges.map(change => change.uri.fsPath));
        for (const change of repository.state.workingTreeChanges) {
            if (indexed.has(change.uri.fsPath)) {
                this.pendingPaths.add(change.uri.fsPath);
            }
        }
        for (const [key, value] of snapshot) {
            if (this.lastSnapshot.get(key) !== value) {
                this.pendingPaths.add(key);
            }
        }
        for (const key of this.lastSnapshot.keys()) {
            if (!snapshot.has(key)) {
                this.pendingPaths.add(key);
            }
        }
        this.lastSnapshot = snapshot;
        this.schedule();
    }

    private schedule(): void {
        if (this.isDisposed) {
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
    }

    private flush(): void {
        this.timer = undefined;
        const change: RepositoryChange = {
            isFull: this.isFullPending,
            isStashChanged: this.isStashPending,
            isRecheckNeeded: this.isRecheckPending,
            paths: Array.from(this.pendingPaths),
            recordFiles: Array.from(this.pendingRecordFiles),
        };
        this.isFullPending = false;
        this.isStashPending = false;
        this.isRecheckPending = false;
        this.pendingPaths.clear();
        this.pendingRecordFiles.clear();
        if (change.isFull || change.isStashChanged || change.isRecheckNeeded || change.paths.length > 0 || change.recordFiles.length > 0) {
            this.logger.info(`Watcher: full=${change.isFull} stash=${change.isStashChanged} recheck=${change.isRecheckNeeded} paths=${change.paths.length} [${change.paths.slice(0, 5).join(', ')}${change.paths.length > 5 ? ', ...' : ''}] recordFiles=${change.recordFiles.length}`);
            this.emitter.fire(change);
        }
    }

    dispose(): void {
        this.isDisposed = true;
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.repositoryDisposables.forEach(d => d.dispose());
        this.disposables.forEach(d => d.dispose());
        this.emitter.dispose();
    }
}
