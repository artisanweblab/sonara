import * as vscode from 'vscode';
import { ActiveProject } from '../../shared/active-project';
import { TaskStore } from '../tasks/store/task-store';
import { TasksWebviewPanel } from '../tasks/webview/tasks-webview-panel';
import { IdentityService } from './identity-service';
import { TimerService } from './timer-service';
import { taskFileSlug } from './slug';
import { TimeTrackerStatusBar } from './status-bar';

export async function registerTimeTrackerModule(
    context: vscode.ExtensionContext,
    activeProject: ActiveProject,
    taskStore: TaskStore,
    tasksPanel: TasksWebviewPanel,
): Promise<TimerService> {
    const config = vscode.workspace.getConfiguration('sonara.timeTracker');
    const tickIntervalSec = config.get<number>('tickIntervalSec', 15);
    const flushIntervalSec = config.get<number>('flushIntervalSec', 60);

    const identity = new IdentityService(context.globalState, activeProject);
    const timer = new TimerService(
        context,
        identity,
        activeProject,
        slug => taskStore.hasSlug(slug),
        tickIntervalSec,
        flushIntervalSec,
    );
    context.subscriptions.push(timer);

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (
                event.affectsConfiguration('sonara.timeTracker.tickIntervalSec') ||
                event.affectsConfiguration('sonara.timeTracker.flushIntervalSec')
            ) {
                const updated = vscode.workspace.getConfiguration('sonara.timeTracker');
                timer.reconfigure(
                    updated.get<number>('tickIntervalSec', 15),
                    updated.get<number>('flushIntervalSec', 60),
                );
            }
        }),
    );

    tasksPanel.attachTimerService(timer);

    const statusBar = new TimeTrackerStatusBar(timer);
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.commands.registerCommand('sonara.timeTracker.start', async () => {
            const entries = taskStore.getEntries();
            const items: vscode.QuickPickItem[] = [];
            for (const entry of entries) {
                if (entry.kind !== 'task') continue;
                const slug = taskFileSlug(entry.task.fileUri.fsPath);
                if (!slug) continue;
                items.push({
                    label: entry.task.title,
                    description: slug,
                    detail: entry.task.summary || undefined,
                });
            }
            if (items.length === 0) {
                await vscode.window.showInformationMessage('No tasks available to track.');
                return;
            }
            const picked = await vscode.window.showQuickPick(items, {
                title: 'Start time tracking',
                placeHolder: 'Pick a task',
            });
            if (!picked || !picked.description) return;
            await timer.start(picked.description);
        }),
        vscode.commands.registerCommand('sonara.timeTracker.stop', async () => {
            await timer.stop();
        }),
        vscode.commands.registerCommand('sonara.timeTracker.toggle', async () => {
            const active = timer.getActiveSlug();
            if (active) {
                await timer.stop();
                return;
            }
            await vscode.commands.executeCommand('sonara.timeTracker.start');
        }),
        vscode.commands.registerCommand('sonara.timeTracker.statusBarAction', async () => {
            const slug = timer.getActiveSlug();
            if (!slug) return;
            type ActionId = 'open' | 'stop' | 'switch';
            interface ActionItem extends vscode.QuickPickItem { id: ActionId; }
            const items: ActionItem[] = [
                { id: 'open', label: '$(go-to-file) Open task file', description: slug },
                { id: 'stop', label: '$(debug-stop) Stop timer', description: slug },
                { id: 'switch', label: '$(arrow-swap) Switch to another task', description: 'Pick another task to track' },
            ];
            const picked = await vscode.window.showQuickPick(items, {
                title: 'Time tracker',
                placeHolder: `Active: ${slug}`,
            });
            if (!picked) return;
            if (picked.id === 'stop') {
                await timer.stop();
                return;
            }
            if (picked.id === 'switch') {
                await vscode.commands.executeCommand('sonara.timeTracker.start');
                return;
            }
            const uri = taskStore.getUriBySlug(slug);
            if (!uri) {
                await vscode.window.showWarningMessage(`Task file for \`${slug}\` was not found.`);
                return;
            }
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
        }),
        vscode.commands.registerCommand('sonara.timeTracker.openTodayFile', async () => {
            const filePath = await timer.todayFilePath();
            if (!filePath) {
                await vscode.window.showInformationMessage('No time-tracker user is configured yet.');
                return;
            }
            const uri = vscode.Uri.file(filePath);
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc);
            } catch {
                await vscode.window.showInformationMessage('Today\'s time-tracker file does not exist yet.');
            }
        }),
    );

    const stored = timer.getStoredActiveSlug();
    if (stored) {
        const currentProjectId = activeProject.get()?.uri.toString() ?? null;
        void resumePrompt(timer, taskStore, stored.slug, stored.projectId, currentProjectId);
    }

    return timer;
}

async function resumePrompt(
    timer: TimerService,
    taskStore: TaskStore,
    slug: string,
    storedProjectId: string | null,
    currentProjectId: string | null,
): Promise<void> {
    // If the stored slug belongs to a different project, discard it silently.
    if (storedProjectId !== null && currentProjectId !== null && storedProjectId !== currentProjectId) {
        await timer.clearStoredActive();
        return;
    }
    // Old format (storedProjectId === null): project unknown - do not resume to avoid
    // writing ticks into the wrong project's day-store.
    if (storedProjectId === null) {
        await timer.clearStoredActive();
        return;
    }

    // Wait for task store to be initialized so we can check existence.
    const taskFileExists = (): boolean => {
        const entries = taskStore.getEntries();
        for (const entry of entries) {
            if (entry.kind !== 'task') continue;
            if (taskFileSlug(entry.task.fileUri.fsPath) === slug) {
                return true;
            }
        }
        return false;
    };

    if (!taskFileExists()) {
        await vscode.window.showWarningMessage(
            `Time tracker stopped: task \`${slug}\` no longer exists.`,
        );
        await timer.clearStoredActive();
        return;
    }

    const choice = await vscode.window.showInformationMessage(
        `Time tracker is still running on task \`${slug}\`.`,
        'Continue',
        'Stop',
    );
    if (choice === 'Continue') {
        await timer.continueFromState();
    } else {
        await timer.clearStoredActive();
    }
}
