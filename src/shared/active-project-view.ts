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
            const projects = activeProject.choices();
            if (projects.length === 0) {
                vscode.window.showInformationMessage('No project folders are open.');
                return;
            }
            const current = activeProject.get();
            const items = projects.map(project => ({
                label: `${project.uri.fsPath === current?.uri.fsPath ? '$(check)' : '$(circle-large-outline)'} ${project.name}`,
                description: project.uri.fsPath,
                project,
            }));
            const picked = await pickOne(items, {
                title: 'Switch Active Project',
                placeHolder: 'Select the active project: a workspace folder or a git repository inside it',
            });
            if (picked && picked.project.uri.fsPath !== current?.uri.fsPath) {
                await activeProject.set(picked.project);
            }
        }),
    );
}
