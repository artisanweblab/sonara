import { AppliedMove, FrontierMover, MoveProgress } from './frontiers/frontier-mover';
import { MoveCommand, MoveOutcome } from './frontiers/move-outcome';
import { ReviewLogger } from './logging/review-logger';
import { FileGeneration, LEVEL_LABELS, ReviewFileState, ReviewLevel } from './types';

export interface StageFailure {
    path: string;
    message: string;
}

export interface LevelMoveReport {
    failures: StageFailure[];
    refusals: string[];
    stalePaths: string[];
}

export interface LevelMoveResult {
    report: LevelMoveReport;
    applied: AppliedMove[];
}

export interface LevelMoveRequest {
    repoPath: string;
    sourceLevel: ReviewLevel;
    changeIds: ReadonlySet<string> | null;
    generation: FileGeneration;
}

export interface LevelSelection {
    repoPath: string;
    level: ReviewLevel;
    generation: FileGeneration;
}

export function requestsFromSelections(selections: readonly LevelSelection[]): LevelMoveRequest[] {
    const requests = new Map<string, LevelMoveRequest>();
    for (const selection of selections) {
        const id = `${selection.repoPath}\0${selection.level}`;
        if (!requests.has(id)) {
            requests.set(id, { repoPath: selection.repoPath, sourceLevel: selection.level, changeIds: null, generation: selection.generation });
        }
    }
    return Array.from(requests.values());
}

export class ReviewLevelMover {
    constructor(
        private readonly mover: FrontierMover,
        private readonly logger: ReviewLogger,
        private readonly getFile: (repoPath: string) => ReviewFileState | undefined,
    ) {}

    async move(requests: readonly LevelMoveRequest[], target: ReviewLevel, progress: MoveProgress): Promise<LevelMoveResult> {
        const report: LevelMoveReport = { failures: [], refusals: [], stalePaths: [] };
        const applied = new Map<string, AppliedMove>();
        const stoppedPaths = new Set<string>();
        const chained = new Map<string, { from: FileGeneration; to: FileGeneration }>();
        for (const round of this.rounds(requests)) {
            const commands: MoveCommand[] = [];
            const byCommand = new Map<MoveCommand, LevelMoveRequest>();
            for (const request of round) {
                const command = this.command(request, target, report, stoppedPaths, chained);
                if (command) {
                    commands.push(command);
                    byCommand.set(command, request);
                }
            }
            if (commands.length === 0) {
                continue;
            }
            const batch = await this.mover.move(commands, progress);
            commands.forEach((command, position) => this.record(byCommand.get(command) as LevelMoveRequest, batch.outcomes[position], report, stoppedPaths, chained));
            batch.applied.forEach(move => applied.set(move.repoPath, move));
        }
        return { report, applied: Array.from(applied.values()) };
    }

    private rounds(requests: readonly LevelMoveRequest[]): LevelMoveRequest[][] {
        const rounds: LevelMoveRequest[][] = [];
        const nextRound = new Map<string, number>();
        for (const request of requests) {
            const round = nextRound.get(request.repoPath) ?? 0;
            nextRound.set(request.repoPath, round + 1);
            (rounds[round] ??= []).push(request);
        }
        return rounds;
    }

    private command(
        request: LevelMoveRequest,
        target: ReviewLevel,
        report: LevelMoveReport,
        stoppedPaths: ReadonlySet<string>,
        chained: ReadonlyMap<string, { from: FileGeneration; to: FileGeneration }>,
    ): MoveCommand | null {
        if (stoppedPaths.has(request.repoPath)) {
            return null;
        }
        if (request.sourceLevel === target) {
            report.refusals.push(`${request.repoPath}: the changes are already on the ${LEVEL_LABELS[target]} level.`);
            return null;
        }
        const file = this.getFile(request.repoPath);
        if (!file) {
            this.logger.info(`Stale guard: ${request.repoPath} not moved, the file is no longer in the list`);
            report.stalePaths.push(request.repoPath);
            return null;
        }
        const previous = chained.get(request.repoPath);
        const generation = previous && previous.from === request.generation ? previous.to : request.generation;
        return { file: file.scanned, generation, source: request.sourceLevel, target, changeIds: request.changeIds };
    }

    private record(
        request: LevelMoveRequest,
        outcome: MoveOutcome,
        report: LevelMoveReport,
        stoppedPaths: Set<string>,
        chained: Map<string, { from: FileGeneration; to: FileGeneration }>,
    ): void {
        switch (outcome.kind) {
            case 'stale':
                this.logger.info(`Stale guard: ${request.repoPath} not moved, ${outcome.reason}`);
                stoppedPaths.add(request.repoPath);
                report.stalePaths.push(request.repoPath);
                return;
            case 'refused':
                this.logger.info(`Refusal: ${outcome.message}`);
                report.refusals.push(outcome.message);
                return;
            case 'failed':
                stoppedPaths.add(request.repoPath);
                report.failures.push({ path: request.repoPath, message: outcome.message });
                return;
            case 'moved':
                chained.set(request.repoPath, { from: request.generation, to: outcome.generation });
        }
    }
}
