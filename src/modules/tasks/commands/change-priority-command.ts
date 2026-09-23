import * as vscode from 'vscode';
import { TaskStore } from '../store/task-store';
import { updateFrontmatter } from '../parser/update-frontmatter';
import { PRIORITIES, PRIORITY_LABELS, TaskPriority } from '../types';

export async function executeChangePriority(store: TaskStore, fsPath: string): Promise<void> {
    const task = store.getTaskByPath(fsPath);
    if (!task) {
        return;
    }

    const items: (vscode.QuickPickItem & { id: TaskPriority })[] = PRIORITIES.map(p => ({
        id: p,
        label: PRIORITY_LABELS[p],
        description: task.priority === p ? '(current)' : undefined,
        picked: task.priority === p,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: `Priority for "${task.title}"`,
        placeHolder: `Current: ${PRIORITY_LABELS[task.priority]}`,
        ignoreFocusOut: true,
    });
    if (!picked || task.priority === picked.id) {
        return;
    }
    await updateFrontmatter(task.fileUri, { priority: picked.id });
}
