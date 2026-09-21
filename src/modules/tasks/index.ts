import * as vscode from 'vscode';
import { TaskStore } from './store/task-store';
import { TasksWebviewPanel } from './webview/tasks-webview-panel';
import { executeNewTask } from './commands/new-task-command';
import { executeRefresh } from './commands/refresh-command';
import { executeCopyAgentContext } from './commands/copy-agent-context-command';
import { ActiveProject } from '../../shared/active-project';
import { ChannelOutputLog, registerLoggedCommand } from '../../shared/output-log';
import { createTimestampedOutputChannel } from '../../shared/timestamped-channel';

const PRODUCT = 'Sonara Tasks';

export interface TasksModuleHandles {
    store: TaskStore;
    panel: TasksWebviewPanel;
}

export async function registerTasksModule(
    context: vscode.ExtensionContext,
    activeProject: ActiveProject,
): Promise<TasksModuleHandles> {
    const channel = createTimestampedOutputChannel(PRODUCT);
    context.subscriptions.push(channel);
    const log = new ChannelOutputLog(channel);

    const store = new TaskStore(activeProject);
    context.subscriptions.push(store);

    const panel = new TasksWebviewPanel(store, context.extensionUri, context.workspaceState, log);
    context.subscriptions.push(panel);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(TasksWebviewPanel.VIEW_ID, panel, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    context.subscriptions.push(
        registerLoggedCommand(log, PRODUCT, 'sonara.tasks.new', () => executeNewTask(store)),
        registerLoggedCommand(log, PRODUCT, 'sonara.tasks.copyAgentContext', () => executeCopyAgentContext(activeProject)),
        registerLoggedCommand(log, PRODUCT, 'sonara.tasks.refresh', () => executeRefresh(store)),
    );

    await store.initialize();

    return { store, panel };
}
