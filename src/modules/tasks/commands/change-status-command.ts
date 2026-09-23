import * as vscode from 'vscode';
import { TaskStore } from '../store/task-store';
import { updateFrontmatter } from '../parser/update-frontmatter';
import { STATUSES, STATUS_LABELS, TaskStatus } from '../types';

export async function executeChangeStatus(store: TaskStore, fsPath: string): Promise<void> {
    const task = store.getTaskByPath(fsPath);
    if (!task) {
        return;
    }

    const items: (vscode.QuickPickItem & { id: TaskStatus })[] = STATUSES.map(s => ({
        id: s,
        label: STATUS_LABELS[s],
        description: task.status === s ? '(current)' : undefined,
        picked: task.status === s,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: `Status for "${task.title}"`,
        placeHolder: task.status ? `Current: ${STATUS_LABELS[task.status]}` : 'No status',
        ignoreFocusOut: true,
    });
    if (!picked || task.status === picked.id) {
        return;
    }
    await updateFrontmatter(task.fileUri, { status: picked.id });
}
