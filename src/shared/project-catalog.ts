import * as path from 'path';
import * as vscode from 'vscode';
import type { API } from './git/git-api';
import { loadGitApi } from './git/git-extension';
import { SonaraProject } from './sonara-project';

export function isInsideFolder(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class ProjectCatalog implements vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.emitter.event;

    private readonly disposables: vscode.Disposable[] = [];
    private api: API | undefined;
    private gitProblem: string | undefined;
    private isGitSettled = false;

    async start(): Promise<void> {
        this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.emitter.fire()));
        const loaded = await loadGitApi();
        if ('api' in loaded) {
            const api = loaded.api;
            this.api = api;
            this.isGitSettled = api.state === 'initialized';
            this.disposables.push(
                api.onDidOpenRepository(() => this.emitter.fire()),
                api.onDidCloseRepository(() => this.emitter.fire()),
                api.onDidChangeState(state => {
                    this.isGitSettled = state === 'initialized';
                    this.emitter.fire();
                }),
            );
        } else {
            this.gitProblem = loaded.reason;
            this.isGitSettled = true;
        }
        this.emitter.fire();
    }

    isReady(): boolean {
        return this.isGitSettled;
    }

    candidates(): SonaraProject[] {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const projects = new Map<string, SonaraProject>();
        for (const folder of folders) {
            projects.set(folder.uri.fsPath, { uri: folder.uri, name: folder.name });
        }
        const repositories = (this.api?.repositories ?? [])
            .map(repository => repository.rootUri)
            .filter(root => folders.some(folder => isInsideFolder(root.fsPath, folder.uri.fsPath)))
            .sort((a, b) => a.fsPath.localeCompare(b.fsPath));
        for (const root of repositories) {
            if (!projects.has(root.fsPath)) {
                projects.set(root.fsPath, { uri: root, name: path.basename(root.fsPath) });
            }
        }
        return Array.from(projects.values());
    }

    gitProjects(): SonaraProject[] {
        const api = this.api;
        return api ? this.candidates().filter(project => api.getRepository(project.uri) !== null) : [];
    }

    describeMissingGit(): string {
        if (this.gitProblem) {
            return this.gitProblem;
        }
        return this.isGitSettled ? 'no git repository was found in the open folders' : 'the built-in Git extension is still looking for repositories';
    }

    dispose(): void {
        this.disposables.forEach(disposable => disposable.dispose());
        this.emitter.dispose();
    }
}
