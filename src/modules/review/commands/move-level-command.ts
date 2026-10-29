import * as vscode from 'vscode';
import { LevelMoveReport, LevelSelection } from '../review-level-mover';
import { ReviewService, inactiveMessage } from '../review-service';
import { ReviewServices } from '../review-services';
import { BACKLOG_LEVEL, LEVEL_LABELS, REVIEW_LEVELS, REVIEW_LEVELS_TOP_DOWN, ReviewLevel, SHOWN_LEVELS, SHOWN_LEVELS_TOP_DOWN, ShownLevel, reviewLevelRank } from '../types';
import { LevelContentNode, ReviewNode } from '../view/review-node';
import { ReviewTreeProvider } from '../view/review-tree-provider';
import { pickOne } from '../../../shared/quick-input';

export type MoveDirection = 'up' | 'down' | 'pick' | ShownLevel;

interface LevelPickItem<L extends ShownLevel> extends vscode.QuickPickItem {
    level: L;
}

const NOTHING_MOVED: LevelMoveReport = { failures: [], refusals: [], stalePaths: [] };

export function shiftedLevel(level: ReviewLevel, direction: 'up' | 'down'): ReviewLevel | null {
    const rank = reviewLevelRank(level) + (direction === 'up' ? 1 : -1);
    return rank >= 0 && rank < REVIEW_LEVELS.length ? REVIEW_LEVELS[rank] : null;
}

function shiftedShownLevel(level: ShownLevel, direction: 'up' | 'down'): ShownLevel | null {
    const rank = SHOWN_LEVELS.indexOf(level) + (direction === 'up' ? 1 : -1);
    return rank >= 0 && rank < SHOWN_LEVELS.length ? SHOWN_LEVELS[rank] : null;
}

function targetLevel(direction: MoveDirection, current: ShownLevel, picked: ShownLevel | null): ShownLevel | null {
    if (direction === 'pick') {
        return picked;
    }
    return direction === 'up' || direction === 'down' ? shiftedShownLevel(current, direction) : direction;
}

async function pickFrom<L extends ShownLevel>(levels: readonly L[], current: L): Promise<L | null> {
    const items: LevelPickItem<L>[] = levels.map(level => ({
        level,
        label: LEVEL_LABELS[level],
        description: level === current ? 'current' : undefined,
    }));
    const picked = await pickOne(items, { title: 'Move to Level', placeHolder: 'Pick a review level' });
    return picked ? picked.level : null;
}

export function pickLevel(current: ReviewLevel): Promise<ReviewLevel | null> {
    return pickFrom(REVIEW_LEVELS_TOP_DOWN, current);
}

interface MoveBatch {
    service: ReviewService;
    source: ShownLevel;
    target: ShownLevel;
    selections: LevelSelection[];
}

async function moveSelections(batch: MoveBatch): Promise<LevelMoveReport> {
    const repoPaths = batch.selections.map(selection => selection.repoPath);
    if (batch.target === BACKLOG_LEVEL) {
        await batch.service.setBacklog(repoPaths, true);
        return NOTHING_MOVED;
    }
    if (batch.source === BACKLOG_LEVEL) {
        await batch.service.setBacklog(repoPaths, false);
        if (batch.target === 'new') {
            return NOTHING_MOVED;
        }
    }
    return await batch.service.moveToLevel(batch.selections, batch.target);
}

function skipReason(direction: MoveDirection, current: ShownLevel, target: ShownLevel | null): string | null {
    if (!target) {
        return `there is no level ${direction === 'up' ? 'above' : 'below'} ${LEVEL_LABELS[current]}`;
    }
    if (target === current) {
        return `the changes are already on ${LEVEL_LABELS[target]}`;
    }
    return target === BACKLOG_LEVEL && current !== 'new' ? `only changes on ${LEVEL_LABELS.new} can be sent to ${LEVEL_LABELS[BACKLOG_LEVEL]}` : null;
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
    const picked = direction === 'pick' ? await pickFrom(SHOWN_LEVELS_TOP_DOWN, node.level) : null;
    if (direction === 'pick' && !picked) {
        return;
    }
    const batches = new Map<string, MoveBatch>();
    const skipped: string[] = [];
    for (const { current, selections } of frozen) {
        const target = targetLevel(direction, current.level, picked);
        const reason = skipReason(direction, current.level, target);
        if (!target || reason) {
            skipped.push(reason ?? '');
            continue;
        }
        const service = services.get(current.project);
        if (selections.length === 0 || !service) {
            skipped.push(`nothing is on the ${LEVEL_LABELS[current.level]} level there`);
            continue;
        }
        const key = `${current.project}\0${current.level}\0${target}`;
        const batch = batches.get(key) ?? { service, source: current.level, target, selections: [] };
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
    for (const batch of batches.values()) {
        const report = await moveSelections(batch);
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
