import * as vscode from 'vscode';
import { BACKLOG_LEVEL, LEVEL_LABELS, SHOWN_LEVELS, ShownLevel } from '../types';
import { LevelContentNode, ReviewNode } from '../view/review-node';
import { pickOne } from '../../../shared/quick-input';

interface ActionItem extends vscode.QuickPickItem {
    command?: string;
}

const SEPARATOR: ActionItem = { label: '', kind: vscode.QuickPickItemKind.Separator };

function levelSuffix(level: ShownLevel): string {
    return `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;
}

function moveActions(node: LevelContentNode): ActionItem[] {
    const all = node.type === 'level';
    const prefix = all ? 'sonara.review.moveAll' : 'sonara.review.move';
    const what = all ? 'All ' : '';
    const actions: ActionItem[] = [];
    if (node.level !== 'staged') {
        actions.push({ label: `Move ${what}Up`, command: `${prefix}Up` });
    }
    if (node.level !== BACKLOG_LEVEL) {
        actions.push({ label: `Move ${what}Down`, command: `${prefix}Down` });
    }
    actions.push(SEPARATOR);
    for (const level of SHOWN_LEVELS) {
        if (level !== node.level && (level !== BACKLOG_LEVEL || node.level === 'new')) {
            actions.push({ label: `Move ${what}to ${LEVEL_LABELS[level]}`, command: `${prefix}To${levelSuffix(level)}` });
        }
    }
    return actions;
}

function fileActions(): ActionItem[] {
    return [
        SEPARATOR,
        { label: 'Open Containing Folder', command: 'sonara.review.revealInOS' },
        { label: 'Copy Path', command: 'sonara.review.copyPath' },
        { label: 'Copy Relative Path', command: 'sonara.review.copyRelativePath' },
        SEPARATOR,
        { label: 'Delete', command: 'sonara.review.delete' },
    ];
}

function nodeTitle(node: LevelContentNode): string {
    if (node.type === 'level') {
        return LEVEL_LABELS[node.level];
    }
    return node.displayPath;
}

export async function executeShowActions(node: ReviewNode | undefined, selection: ReviewNode[] | undefined): Promise<void> {
    if (!node || node.type === 'repository') {
        return;
    }
    const actions = node.type === 'level' ? moveActions(node) : [...moveActions(node), ...fileActions()];
    const picked = await pickOne(actions, { title: nodeTitle(node), placeHolder: 'Pick an action' });
    if (picked?.command) {
        await vscode.commands.executeCommand(picked.command, node, selection);
    }
}
