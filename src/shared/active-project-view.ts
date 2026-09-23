import * as vscode from 'vscode';
import { ActiveProject } from './active-project';
import { pickOne } from './quick-input';

export const ACTIVE_PROJECT_PICK_COMMAND = 'sonara.activeProject.pick';

export function registerActiveProjectPicker(
    context: vscode.ExtensionContext,
    activeProject: ActiveProject,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(ACTIVE_PROJECT_PICK_COMMAND, async () => {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) {
                vscode.window.showInformationMessage('No workspace folders are open.');
                return;
            }
            const current = activeProject.get();
            const items = folders.map(f => ({
                label: `${f.uri.toString() === current?.uri.toString() ? '$(check)' : '$(circle-large-outline)'} ${f.name}`,
                description: f.uri.fsPath,
                folder: f,
            }));
            const picked = await pickOne(items, {
                title: 'Switch Active Project',
                placeHolder: 'Select the active project folder',
            });
            if (picked && picked.folder.uri.toString() !== current?.uri.toString()) {
                await activeProject.set(picked.folder);
            }
        }),
    );
}
