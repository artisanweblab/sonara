import * as vscode from 'vscode';
import * as path from 'path';
import { Task, TaskEntry, TaskParseError } from '../types';
import { parseTaskFile } from '../parser/parse-task-file';
import { pathExists } from '../../../shared/fs-utils';
import { ActiveProject } from '../../../shared/active-project';
import { tasksDir as layoutTasksDir } from '../../../shared/project-layout';

const README_FILENAME_LOWERCASE = 'readme.md';

export class TaskStore implements vscode.Disposable {
    private readonly entriesByFsPath = new Map<string, TaskEntry>();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    private watcher: vscode.FileSystemWatcher | undefined;
    private tasksDir: vscode.Uri | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    public constructor(private readonly activeProject: ActiveProject) {}

    public getTasksDir(): vscode.Uri | undefined {
        return this.tasksDir;
    }

    public hasTasksDir(): boolean {
        return this.tasksDir !== undefined;
    }

    public getEntries(): TaskEntry[] {
        return Array.from(this.entriesByFsPath.values());
    }

    public hasSlug(slug: string): boolean {
        return this.getUriBySlug(slug) !== undefined;
    }

    public getUriBySlug(slug: string): vscode.Uri | undefined {
        for (const [fsPath, entry] of this.entriesByFsPath) {
            const base = path.basename(fsPath);
            if (base.toLowerCase().endsWith('.md') && base.slice(0, -3) === slug) {
                return entry.kind === 'task' ? entry.task.fileUri : entry.error.fileUri;
            }
        }
        return undefined;
    }

    public getTaskByPath(fsPath: string): Task | undefined {
        const entry = this.entriesByFsPath.get(fsPath);
        return entry?.kind === 'task' ? entry.task : undefined;
    }

    public getErrorByPath(fsPath: string): TaskParseError | undefined {
        const entry = this.entriesByFsPath.get(fsPath);
        return entry?.kind === 'error' ? entry.error : undefined;
    }

    public getUriByPath(fsPath: string): vscode.Uri | undefined {
        return this.getTaskByPath(fsPath)?.fileUri ?? this.getErrorByPath(fsPath)?.fileUri;
    }

    public getAllSprints(): string[] {
        const set = new Set<string>();
        for (const entry of this.entriesByFsPath.values()) {
            if (entry.kind === 'task' && entry.task.sprint) {
                set.add(entry.task.sprint);
            }
        }
        return Array.from(set).sort();
    }

    public getAllLabels(): string[] {
        const set = new Set<string>();
        for (const entry of this.entriesByFsPath.values()) {
            if (entry.kind === 'task') {
                for (const label of entry.task.labels) {
                    set.add(label);
                }
            }
        }
        return Array.from(set).sort();
    }

    public async initialize(): Promise<void> {
        this.disposables.push(
            this.activeProject.onDidChange(() => void this.switchToActiveProject()),
        );
        await this.switchToActiveProject();
    }

    private async switchToActiveProject(): Promise<void> {
        this.stopWatcher();
        this.entriesByFsPath.clear();
        this.tasksDir = undefined;

        const folder = this.activeProject.get();
        if (!folder) {
            this._onDidChange.fire();
            return;
        }

        const candidate = vscode.Uri.file(layoutTasksDir(folder));
        if (await pathExists(candidate)) {
            this.tasksDir = candidate;
            this.startWatcher();
            await this.rescan();
        } else {
            this._onDidChange.fire();
        }
    }

    public async ensureTasksDir(): Promise<vscode.Uri | undefined> {
        if (this.tasksDir) {
            return this.tasksDir;
        }
        const folder = this.activeProject.get();
        if (!folder) {
            return undefined;
        }
        const dir = vscode.Uri.file(layoutTasksDir(folder));
        await vscode.workspace.fs.createDirectory(dir);
        this.tasksDir = dir;
        this.startWatcher();
        await this.rescan();
        return dir;
    }

    public async rescan(): Promise<void> {
        if (!this.tasksDir) {
            this.entriesByFsPath.clear();
            this._onDidChange.fire();
            return;
        }
        const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(this.tasksDir, '**/*.md'),
            null,
        );
        const taskFiles = files.filter(uri => !this.isReadme(uri));

        const next = new Map<string, TaskEntry>();
        for (const uri of taskFiles) {
            const entry = await parseTaskFile(uri);
            next.set(uri.fsPath, entry);
        }
        this.entriesByFsPath.clear();
        for (const [k, v] of next) {
            this.entriesByFsPath.set(k, v);
        }
        this._onDidChange.fire();
    }

    private startWatcher(): void {
        if (!this.tasksDir || this.watcher) {
            return;
        }
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.tasksDir, '**/*.md'),
        );
        const isOnDisk = (uri: vscode.Uri): boolean => uri.scheme === this.tasksDir?.scheme;
        watcher.onDidCreate(uri => {
            if (isOnDisk(uri)) void this.handleFileChange(uri);
        });
        watcher.onDidChange(uri => {
            if (isOnDisk(uri)) void this.handleFileChange(uri);
        });
        watcher.onDidDelete(uri => {
            if (isOnDisk(uri)) this.handleFileDelete(uri);
        });
        this.watcher = watcher;
    }

    private stopWatcher(): void {
        this.watcher?.dispose();
        this.watcher = undefined;
    }

    private async handleFileChange(uri: vscode.Uri): Promise<void> {
        if (this.isReadme(uri)) {
            return;
        }
        const entry = await parseTaskFile(uri);
        this.entriesByFsPath.set(uri.fsPath, entry);
        this._onDidChange.fire();
    }

    private handleFileDelete(uri: vscode.Uri): void {
        if (this.isReadme(uri)) {
            return;
        }
        if (this.entriesByFsPath.delete(uri.fsPath)) {
            this._onDidChange.fire();
        }
    }

    private isReadme(uri: vscode.Uri): boolean {
        if (!this.tasksDir) {
            return false;
        }
        const inRoot = path.dirname(uri.fsPath) === this.tasksDir.fsPath;
        return inRoot && path.basename(uri.fsPath).toLowerCase() === README_FILENAME_LOWERCASE;
    }

    public dispose(): void {
        this.stopWatcher();
        this.disposables.forEach(d => d.dispose());
        this._onDidChange.dispose();
    }
}
