import * as vscode from 'vscode';
import { addCancelButton } from '../../../shared/quick-input';

const CREATE_ID = '__create__';
const DONE_ID = '__done__';
const REMOVE_ID = '__remove__';

interface PickItem extends vscode.QuickPickItem {
    id: string;
    valueName?: string;
}

interface ExtraAction {
    id: string;
    label: string;
    visible?: () => boolean;
}

export interface FilterablePickerOptions {
    title: string;
    placeholder: string;
    allValues: string[];
    selected: Set<string>;
    mode: 'single' | 'multi';
    createLabel?: (query: string) => string;
    extraActions?: ExtraAction[];
}

export type FilterablePickerResult =
    | { kind: 'confirmed'; selected: Set<string> }
    | { kind: 'extra'; actionId: string }
    | { kind: 'cancelled' };

/**
 * Universal filterable picker with toggle + create-on-the-fly.
 * - mode 'single': Enter on a value selects it and closes.
 * - mode 'multi': Enter on a value toggles it; a "Done" item confirms.
 * - Typing a value not in the list adds a "Create '<query>'" item.
 */
export async function runFilterablePicker(opts: FilterablePickerOptions): Promise<FilterablePickerResult> {
    return new Promise<FilterablePickerResult>(resolve => {
        const picker = vscode.window.createQuickPick<PickItem>();
        picker.title = opts.title;
        picker.placeholder = opts.placeholder;
        picker.ignoreFocusOut = true;
        addCancelButton(picker);
        picker.matchOnDescription = false;
        picker.matchOnDetail = false;

        const values = [...opts.allValues];
        const selected = new Set(opts.selected);

        const rebuild = (): void => {
            const query = picker.value.trim();
            const items: PickItem[] = values.map(value => ({
                id: value,
                valueName: value,
                label: `${selected.has(value) ? '$(check)' : '$(circle-large-outline)'} ${value}`,
            }));
            if (query && !values.includes(query)) {
                const createText = opts.createLabel ? opts.createLabel(query) : `Create "${query}"`;
                items.push({
                    id: CREATE_ID,
                    valueName: query,
                    label: `$(add) ${createText}`,
                    alwaysShow: true,
                });
            }
            if (opts.mode === 'multi') {
                items.push({ id: DONE_ID, label: '$(arrow-right) Done', alwaysShow: true });
            }
            for (const extra of opts.extraActions ?? []) {
                if (extra.visible && !extra.visible()) {
                    continue;
                }
                items.push({ id: extra.id, label: extra.label, alwaysShow: true });
            }
            picker.items = items;
        };

        let result: FilterablePickerResult = { kind: 'cancelled' };

        picker.onDidChangeValue(() => rebuild());

        picker.onDidAccept(() => {
            const active = picker.activeItems[0];
            if (!active) {
                return;
            }
            if (active.id === DONE_ID) {
                result = { kind: 'confirmed', selected: new Set(selected) };
                picker.hide();
                return;
            }
            if (opts.extraActions?.some(a => a.id === active.id)) {
                result = { kind: 'extra', actionId: active.id };
                picker.hide();
                return;
            }
            if (active.id === CREATE_ID && active.valueName) {
                const name = active.valueName;
                if (!values.includes(name)) {
                    values.push(name);
                    values.sort();
                }
                if (opts.mode === 'single') {
                    selected.clear();
                    selected.add(name);
                    result = { kind: 'confirmed', selected: new Set(selected) };
                    picker.hide();
                    return;
                }
                selected.add(name);
                picker.value = '';
                rebuild();
                const created = picker.items.find(i => i.id === name);
                if (created) {
                    picker.activeItems = [created];
                }
                return;
            }
            if (active.valueName) {
                const name = active.valueName;
                if (opts.mode === 'single') {
                    selected.clear();
                    selected.add(name);
                    result = { kind: 'confirmed', selected: new Set(selected) };
                    picker.hide();
                    return;
                }
                if (selected.has(name)) {
                    selected.delete(name);
                } else {
                    selected.add(name);
                }
                rebuild();
                const same = picker.items.find(i => i.id === name);
                if (same) {
                    picker.activeItems = [same];
                }
            }
        });

        picker.onDidHide(() => {
            picker.dispose();
            resolve(result);
        });

        rebuild();
        picker.show();
    });
}

export const PICKER_REMOVE_ID = REMOVE_ID;
