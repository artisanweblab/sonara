import { TaskStore } from '../store/task-store';
import { updateFrontmatter } from '../parser/update-frontmatter';
import { runFilterablePicker, PICKER_REMOVE_ID } from './filterable-picker';

export async function executeChangeSprint(store: TaskStore, fsPath: string): Promise<void> {
    const task = store.getTaskByPath(fsPath);
    if (!task) {
        return;
    }

    const sprints = store.getAllSprints();
    if (task.sprint && !sprints.includes(task.sprint)) {
        sprints.push(task.sprint);
        sprints.sort();
    }

    const result = await runFilterablePicker({
        title: `Sprint for "${task.title}"`,
        placeholder: task.sprint
            ? `Current: ${task.sprint}. Type to filter or create.`
            : 'Type to filter or create.',
        allValues: sprints,
        selected: new Set(task.sprint ? [task.sprint] : []),
        mode: 'single',
        extraActions: task.sprint
            ? [{ id: PICKER_REMOVE_ID, label: '$(close) Remove from sprint' }]
            : [],
    });

    let next: string | null | undefined;
    if (result.kind === 'cancelled') {
        return;
    }
    if (result.kind === 'extra' && result.actionId === PICKER_REMOVE_ID) {
        next = null;
    } else if (result.kind === 'confirmed') {
        const first = result.selected.values().next();
        next = first.done ? null : first.value;
    } else {
        return;
    }

    if (task.sprint === next) {
        return;
    }
    await updateFrontmatter(task.fileUri, { sprint: next });
}
