import * as vscode from 'vscode';
import { ReviewService } from '../review-service';
import { REVIEW_LEVELS, REVIEW_LEVELS_TOP_DOWN, ReviewLevel } from '../types';

function formatCounts(counts: Map<ReviewLevel, number>): string {
    return REVIEW_LEVELS_TOP_DOWN
        .filter(level => (counts.get(level) ?? 0) > 0)
        .map(level => `${level}: ${counts.get(level)}`)
        .join(', ');
}

export function executeShowSummary(output: vscode.OutputChannel, service: ReviewService | undefined): void {
    output.show(true);
    if (!service || !service.isActive()) {
        output.appendLine('Review summary: no active git repository for the current project.');
        return;
    }
    const byLevel = service.getAtomsByLevel();
    const totals = new Map<ReviewLevel, number>(REVIEW_LEVELS.map(level => [level, byLevel.get(level)?.length ?? 0]));
    const files = service.getFiles();
    output.appendLine(`Review summary for ${service.getRepositoryRoot()} (${files.length} files)`);
    for (const level of REVIEW_LEVELS_TOP_DOWN) {
        output.appendLine(`  ${level.padEnd(8)} ${totals.get(level) ?? 0}`);
    }
    for (const file of files) {
        const counts = new Map<ReviewLevel, number>();
        for (const state of file.atoms) {
            counts.set(state.level, (counts.get(state.level) ?? 0) + 1);
        }
        output.appendLine(`  ${file.path}  ${formatCounts(counts)}`);
    }
}
