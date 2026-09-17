import * as vscode from 'vscode';
import { LevelSelection } from '../review-level-mover';
import { inactiveMessage } from '../review-service';
import { ReviewServiceHolder } from '../review-service-holder';
import { LEVEL_LABELS, REVIEW_LEVELS, REVIEW_LEVELS_TOP_DOWN, ReviewLevel, reviewLevelRank } from '../types';
import { ReviewNode } from '../view/review-node';
import { ReviewTreeProvider } from '../view/review-tree-provider';

export type MoveDirection = 'up' | 'down' | 'pick';

interface LevelPickItem extends vscode.QuickPickItem {
    level: ReviewLevel;
}

export function shiftedLevel(level: ReviewLevel, direction: 'up' | 'down'): ReviewLevel | null {
    const rank = reviewLevelRank(level) + (direction === 'up' ? 1 : -1);
    return rank >= 0 && rank < REVIEW_LEVELS.length ? REVIEW_LEVELS[rank] : null;
}

export async function pickLevel(current: ReviewLevel): Promise<ReviewLevel | null> {
    const items: LevelPickItem[] = REVIEW_LEVELS_TOP_DOWN.map(level => ({
        level,
        label: LEVEL_LABELS[level],
        description: level === current ? 'current' : undefined,
    }));
    const picked = await vscode.window.showQuickPick(items, { title: 'Move to Level', placeHolder: 'Pick a review level' });
    return picked ? picked.level : null;
}

export async function executeMoveLevel(
    holder: ReviewServiceHolder,
    provider: ReviewTreeProvider,
    direction: MoveDirection,
    node: ReviewNode | undefined,
    selection: readonly ReviewNode[] | undefined,
): Promise<void> {
    const service = holder.get();
    if (!service || !service.isActive()) {
        await vscode.window.showInformationMessage(inactiveMessage(service));
        return;
    }
    if (!node) {
        await vscode.window.showInformationMessage('Sonara Review: select a level, folder or file in the Review panel first.');
        return;
    }
    const nodes = selection && selection.includes(node) ? selection : [node];
    const frozen = nodes.map(current => ({ current, selections: provider.selectionsOf(current) }));
    const picked = direction === 'pick' ? await pickLevel(node.level) : null;
    if (direction === 'pick' && !picked) {
        return;
    }
    const byTarget = new Map<ReviewLevel, LevelSelection[]>();
    const skipped: string[] = [];
    for (const { current, selections } of frozen) {
        const target = direction === 'pick' ? picked : shiftedLevel(current.level, direction);
        if (!target || target === current.level) {
            skipped.push(!target
                ? `there is no level ${direction === 'up' ? 'above' : 'below'} ${LEVEL_LABELS[current.level]}`
                : `the changes are already on ${LEVEL_LABELS[target]}`);
            continue;
        }
        if (selections.length === 0) {
            skipped.push(`nothing is on the ${LEVEL_LABELS[current.level]} level there`);
            continue;
        }
        byTarget.set(target, [...(byTarget.get(target) ?? []), ...selections]);
    }
    if (byTarget.size === 0) {
        await vscode.window.showInformationMessage(`Sonara Review: nothing was moved, ${Array.from(new Set(skipped)).join('; ')}.`);
        return;
    }
    const failures: string[] = [];
    const refusals: string[] = [];
    const stalePaths = new Set<string>();
    for (const [target, selections] of byTarget) {
        const report = await service.moveToLevel(selections, target);
        failures.push(...report.failures.map(failure => `${failure.path}: ${failure.message}`));
        refusals.push(...report.refusals);
        report.stalePaths.forEach(stalePath => stalePaths.add(stalePath));
    }
    if (failures.length > 0) {
        await vscode.window.showErrorMessage(`Sonara Review could not update the git stage for ${failures.join('; ')}`);
    }
    if (refusals.length > 0) {
        await vscode.window.showWarningMessage(`Sonara Review did not move some changes. ${refusals.join(' ')}`);
    }
    if (stalePaths.size > 0) {
        await vscode.window.showInformationMessage(
            `Sonara Review: ${Array.from(stalePaths).join(', ')} changed after the list was built. Levels were not changed, the list is being refreshed.`,
        );
    }
}
