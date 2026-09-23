import * as vscode from 'vscode';

// The stock showQuickPick / showInputBox close only with Escape, which a touch screen does not have.

type PickOptions = Pick<vscode.QuickPickOptions, 'title' | 'placeHolder' | 'matchOnDescription' | 'matchOnDetail' | 'ignoreFocusOut'>;

export interface AskTextOptions {
    title?: string;
    prompt?: string;
    placeHolder?: string;
    value?: string;
    ignoreFocusOut?: boolean;
    validateInput?: (value: string) => string | null;
}

export function addCancelButton(input: vscode.QuickPick<vscode.QuickPickItem> | vscode.InputBox): void {
    const cancel: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('close'), tooltip: 'Cancel' };
    input.buttons = [...input.buttons, cancel];
    input.onDidTriggerButton(button => {
        if (button === cancel) {
            input.hide();
        }
    });
}

function preparePicker<T extends vscode.QuickPickItem>(items: readonly T[], options: PickOptions, canSelectMany: boolean): vscode.QuickPick<T> {
    const picker = vscode.window.createQuickPick<T>();
    picker.items = items;
    picker.title = options.title;
    picker.placeholder = options.placeHolder;
    picker.matchOnDescription = options.matchOnDescription ?? false;
    picker.matchOnDetail = options.matchOnDetail ?? false;
    picker.ignoreFocusOut = options.ignoreFocusOut ?? false;
    picker.canSelectMany = canSelectMany;
    addCancelButton(picker);
    return picker;
}

export function pickOne<T extends vscode.QuickPickItem>(items: readonly T[], options: PickOptions = {}): Promise<T | undefined> {
    return new Promise(resolve => {
        const picker = preparePicker(items, options, false);
        let result: T | undefined;
        picker.onDidAccept(() => {
            result = picker.selectedItems[0];
            picker.hide();
        });
        picker.onDidHide(() => {
            picker.dispose();
            resolve(result);
        });
        picker.show();
    });
}

export function pickMany<T extends vscode.QuickPickItem>(items: readonly T[], options: PickOptions = {}): Promise<T[] | undefined> {
    return new Promise(resolve => {
        const picker = preparePicker(items, options, true);
        picker.selectedItems = items.filter(item => item.picked);
        let result: T[] | undefined;
        picker.onDidAccept(() => {
            result = [...picker.selectedItems];
            picker.hide();
        });
        picker.onDidHide(() => {
            picker.dispose();
            resolve(result);
        });
        picker.show();
    });
}

export function askText(options: AskTextOptions = {}): Promise<string | undefined> {
    return new Promise(resolve => {
        const input = vscode.window.createInputBox();
        input.title = options.title;
        input.prompt = options.prompt;
        input.placeholder = options.placeHolder;
        input.value = options.value ?? '';
        input.ignoreFocusOut = options.ignoreFocusOut ?? false;
        addCancelButton(input);

        const validate = (): string | undefined => options.validateInput?.(input.value) ?? undefined;
        let result: string | undefined;
        input.onDidChangeValue(() => {
            input.validationMessage = validate();
        });
        input.onDidAccept(() => {
            const message = validate();
            if (message) {
                input.validationMessage = message;
                return;
            }
            result = input.value;
            input.hide();
        });
        input.onDidHide(() => {
            input.dispose();
            resolve(result);
        });
        input.show();
    });
}
