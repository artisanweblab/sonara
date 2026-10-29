import * as vscode from 'vscode';
import { ReviewService } from '../review-service';
import { SHOWN_LEVELS, SHOWN_LEVELS_TOP_DOWN, ShownLevel } from '../types';

function formatCounts(counts: Map<ShownLevel, number>): string {
    return SHOWN_LEVELS_TOP_DOWN
        .filter(level => (counts.get(level) ?? 0) > 0)
        .map(level => `${level}: ${counts.get(level)}`)
        .join(', ');
}

export function executeShowSummary(output: vscode.OutputChannel, services: readonly ReviewService[]): void {
    output.show(true);
    if (services.length === 0) {
        output.appendLine('Review summary: no git repository is open.');
        return;
    }
    services.forEach(service => appendSummary(output, service));
}

function appendSummary(output: vscode.OutputChannel, service: ReviewService): void {
    if (!service.isActive()) {
        output.appendLine(`Review summary for ${service.project.uri.fsPath}: not active, ${service.getIdleReason()}.`);
        return;
    }
    const byLevel = service.getAtomsByLevel();
    const totals = new Map<ShownLevel, number>(SHOWN_LEVELS.map(level => [level, byLevel.get(level)?.length ?? 0]));
    const files = service.getFiles();
    output.appendLine(`Review summary for ${service.getRepositoryRoot()} (${files.length} files)`);
    for (const level of SHOWN_LEVELS_TOP_DOWN) {
        output.appendLine(`  ${level.padEnd(8)} ${totals.get(level) ?? 0}`);
    }
    for (const file of files) {
        const counts = new Map<ShownLevel, number>();
        for (const state of file.atoms) {
            const level = service.shownLevelOf(file.path, state.level);
            counts.set(level, (counts.get(level) ?? 0) + 1);
        }
        output.appendLine(`  ${file.path}  ${formatCounts(counts)}`);
    }
}
