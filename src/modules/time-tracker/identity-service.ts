import * as vscode from 'vscode';
import { exec } from 'child_process';
import { ActiveProject } from '../../shared/active-project';

const USER_KEY_STATE = 'sonara.timeTracker.userKey';

export class IdentityService {
    public constructor(
        private readonly state: vscode.Memento,
        private readonly activeProject: ActiveProject,
    ) {}

    public get(): string | undefined {
        return this.state.get<string>(USER_KEY_STATE);
    }

    public async resolve(): Promise<string | undefined> {
        const existing = this.get();
        if (existing) {
            return existing;
        }
        return this.ask();
    }

    private async ask(): Promise<string | undefined> {
        const gitEmail = await this.readGitEmail();
        const items: vscode.QuickPickItem[] = [];
        if (gitEmail) {
            items.push({ label: `Use git email (${gitEmail})`, description: 'from git config user.email' });
        }
        items.push({ label: 'Enter name manually', description: 'arbitrary string' });

        const picked = await vscode.window.showQuickPick(items, {
            title: 'Sonara Time Tracker: identify user',
            placeHolder: 'How should we label your time-tracking data?',
        });
        if (!picked) {
            return undefined;
        }
        let raw: string | undefined;
        if (picked.label.startsWith('Use git email') && gitEmail) {
            raw = gitEmail;
        } else {
            raw = await vscode.window.showInputBox({
                title: 'Sonara Time Tracker',
                prompt: 'Enter a name to identify your time-tracking data',
                validateInput: value => (value.trim().length === 0 ? 'Name cannot be empty' : null),
            });
        }
        if (!raw) {
            return undefined;
        }
        const key = this.normalize(raw);
        if (!key) {
            void vscode.window.showErrorMessage(
                'Sonara Time Tracker: the entered name produced an empty identifier. Please use a name with at least one letter or digit (Latin preferred).',
            );
            return undefined;
        }
        await this.state.update(USER_KEY_STATE, key);
        return key;
    }

    private normalize(value: string): string {
        // Allow Unicode letters and digits so non-ASCII names (e.g. Cyrillic) are
        // preserved as-is rather than being silently collapsed to an empty string.
        // Only characters that are unsafe in file-system paths are replaced with '-'.
        const trimmed = value.trim().toLowerCase();
        const replaced = trimmed.replace(/[^\p{L}\p{N}._-]+/gu, '-');
        const collapsed = replaced.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
        return collapsed;
    }

    private readGitEmail(): Promise<string | undefined> {
        return new Promise(resolve => {
            const folder = this.activeProject.get();
            const cwd = folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            exec('git config user.email', { cwd }, (err, stdout) => {
                if (err) {
                    resolve(undefined);
                    return;
                }
                const value = stdout.trim();
                resolve(value.length > 0 ? value : undefined);
            });
        });
    }
}
