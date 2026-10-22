import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectCatalog, isInsideFolder } from './project-catalog';
import { SonaraProject } from './sonara-project';

const STATE_KEY = 'sonara.activeProjectUri';

export class ActiveProject implements vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<SonaraProject | undefined>();
    readonly onDidChange = this.emitter.event;

    private current: SonaraProject | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly state: vscode.Memento,
        private readonly catalog: ProjectCatalog,
    ) {}

    init(): void {
        this.current = this.savedProject();
        this.disposables.push(this.catalog.onDidChange(() => this.reconcile()));
    }

    get(): SonaraProject | undefined {
        return this.current;
    }

    choices(): SonaraProject[] {
        const candidates = this.catalog.candidates();
        const current = this.current;
        return current && !candidates.some(candidate => candidate.uri.fsPath === current.uri.fsPath) ? [current, ...candidates] : candidates;
    }

    async set(project: SonaraProject): Promise<void> {
        this.current = project;
        await this.state.update(STATE_KEY, project.uri.toString());
        this.emitter.fire(this.current);
    }

    private reconcile(): void {
        if (this.current && isAvailable(this.current.uri)) {
            return;
        }
        if (!this.catalog.isReady()) {
            return;
        }
        const next = this.defaultProject();
        if (next?.uri.fsPath !== this.current?.uri.fsPath) {
            this.current = next;
            this.emitter.fire(this.current);
        }
    }

    private savedProject(): SonaraProject | undefined {
        const saved = this.state.get<string>(STATE_KEY);
        if (!saved) {
            return undefined;
        }
        const uri = vscode.Uri.parse(saved);
        if (!isAvailable(uri)) {
            return undefined;
        }
        const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === uri.fsPath);
        return { uri, name: folder?.name ?? path.basename(uri.fsPath) };
    }

    private defaultProject(): SonaraProject | undefined {
        const candidates = this.catalog.candidates();
        if (candidates.length <= 1) {
            return candidates[0];
        }
        const document = vscode.window.activeTextEditor?.document.uri;
        if (document?.scheme !== 'file') {
            return undefined;
        }
        return candidates
            .filter(candidate => isInsideFolder(document.fsPath, candidate.uri.fsPath))
            .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
    }

    dispose(): void {
        this.disposables.forEach(disposable => disposable.dispose());
        this.emitter.dispose();
    }
}

function isAvailable(uri: vscode.Uri): boolean {
    const isInWorkspace = (vscode.workspace.workspaceFolders ?? []).some(folder => isInsideFolder(uri.fsPath, folder.uri.fsPath));
    return isInWorkspace && fs.existsSync(uri.fsPath);
}
