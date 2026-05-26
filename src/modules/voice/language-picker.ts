import * as vscode from 'vscode';

import { LANGUAGE_GROUPS, LANGUAGE_LABELS } from './constants';

export interface LanguageQuickPickItem extends vscode.QuickPickItem {
    value?: string;
}

export function buildLanguageQuickPickItems(
    currentLanguage: string,
    currentMarker: string,
): LanguageQuickPickItem[] {
    const items: LanguageQuickPickItem[] = [];
    for (const group of LANGUAGE_GROUPS) {
        if (group.label) {
            items.push({ label: group.label, kind: vscode.QuickPickItemKind.Separator });
        }
        for (const code of group.codes) {
            items.push({
                label: LANGUAGE_LABELS[code] ?? code,
                description: code === currentLanguage ? currentMarker : '',
                value: code,
            });
        }
    }
    return items;
}
