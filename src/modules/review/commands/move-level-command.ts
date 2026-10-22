import * as vscode from 'vscode';
import { LevelSelection } from '../review-level-mover';
import { ReviewService, inactiveMessage } from '../review-service';
import { ReviewServices } from '../review-services';
import { LEVEL_LABELS, REVIEW_LEVELS, REVIEW_LEVELS_TOP_DOWN, ReviewLevel, reviewLevelRank } from '../types';
import { LevelContentNode, ReviewNode } from '../view/review-node';
import { ReviewTreeProvider } from '../view/review-tree-provider';
import { pickOne } from '../../../shared/quick-input';

export type MoveDirection = 'up' | 'down' | 'pick' | ReviewLevel;

interface LevelPickItem extends vscode.QuickPickItem {
    level: ReviewLevel;
}

export function shiftedLevel(level: ReviewLevel, direction: 'up' | 'down'): ReviewLevel | null {
    const rank = reviewLevelRank(level) + (direction === 'up' ? 1 : -1);
    return rank >= 0 && rank < REVIEW_LEVELS.length ? REVIEW_LEVELS[rank] : null;
}

function targetLevel(direction: MoveDirection, current: ReviewLevel, picked: ReviewLevel | null): ReviewLevel | null {
    if (direction === 'pick') {
        return picked;
    }
    return direction === 'up' || direction === 'down' ? shiftedLevel(current, direction) : direction;
}

export async function pickLevel(current: ReviewLevel): Promise<ReviewLevel | null> {
    const items: LevelPickItem[] = REVIEW_LEVELS_TOP_DOWN.map(level => ({
        level,
        label: LEVEL_LABELS[level],
        description: level === current ? 'current' : undefined,
    }));
    const picked = await pickOne(items, { title: 'Move to Level', placeHolder: 'Pick a review level' });
    return picked ? picked.level : null;
}

interface MoveBatch {
    service: ReviewService;
    target: ReviewLevel;
    selections: LevelSelection[];
}

export async function executeMoveLevel(
    services: ReviewServices,
    provider: ReviewTreeProvider,
    direction: MoveDirection,
    node: ReviewNode | undefined,
    selection: readonly ReviewNode[] | undefined,
): Promise<void> {
    if (!node || node.type === 'repository') {
        await vscode.window.showInformationMessage('Sonara Review: select a level, folder or file in the Review panel first.');
        return;
    }
    const nodes = (selection && selection.includes(node) ? selection : [node])
        .filter((current): current is LevelContentNode => current.type !== 'repository');
    const inactive = nodes.find(current => !services.get(current.project)?.isActive());
    if (inactive) {
        await vscode.window.showInformationMessage(inactiveMessage(services.get(inactive.project)));
        return;
    }
    const frozen = nodes.map(current => ({ current, selections: provider.selectionsOf(current) }));
    const picked = direction === 'pick' ? await pickLevel(node.level) : null;
    if (direction === 'pick' && !picked) {
        return;
    }
    const batches = new Map<string, MoveBatch>();
    const skipped: string[] = [];
    for (const { current, selections } of frozen) {
        const target = targetLevel(direction, current.level, picked);
        if (!target || target === current.level) {
            skipped.push(!target
                ? `there is no level ${direction === 'up' ? 'above' : 'below'} ${LEVEL_LABELS[current.level]}`
                : `the changes are already on ${LEVEL_LABELS[target]}`);
            continue;
        }
        const service = services.get(current.project);
        if (selections.length === 0 || !service) {
            skipped.push(`nothing is on the ${LEVEL_LABELS[current.level]} level there`);
            continue;
        }
        const key = `${current.project}\0${target}`;
        const batch = batches.get(key) ?? { service, target, selections: [] };
        batch.selections.push(...selections);
        batches.set(key, batch);
    }
    if (batches.size === 0) {
        await vscode.window.showInformationMessage(`Sonara Review: nothing was moved, ${Array.from(new Set(skipped)).join('; ')}.`);
        return;
    }
    const failures: string[] = [];
    const refusals: string[] = [];
    const stalePaths = new Set<string>();
    for (const { service, target, selections } of batches.values()) {
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
