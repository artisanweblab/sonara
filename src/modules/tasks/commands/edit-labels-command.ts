import { TaskStore } from '../store/task-store';
import { updateFrontmatter } from '../parser/update-frontmatter';
import { runFilterablePicker } from './filterable-picker';

export async function executeEditLabels(store: TaskStore, fsPath: string): Promise<void> {
    const task = store.getTaskByPath(fsPath);
    if (!task) {
        return;
    }

    const allLabels = store.getAllLabels();
    const selected = new Set(task.labels);
    for (const label of selected) {
        if (!allLabels.includes(label)) {
            allLabels.push(label);
        }
    }
    allLabels.sort();

    const result = await runFilterablePicker({
        title: `Labels for "${task.title}"`,
        placeholder: 'Type to filter or create. Enter to toggle / create. Pick "Done" to confirm.',
        allValues: allLabels,
        selected,
        mode: 'multi',
    });
    if (result.kind !== 'confirmed') {
        return;
    }

    const next = Array.from(result.selected).sort();
    if (sameSet(task.labels, next)) {
        return;
    }
    await updateFrontmatter(task.fileUri, { labels: next.length === 0 ? null : next });
}

function sameSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const setA = new Set(a);
    for (const v of b) {
        if (!setA.has(v)) return false;
    }
    return true;
}
