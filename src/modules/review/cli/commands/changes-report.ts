import { fileChangeId } from '../../frontiers/level-changes';
import { REVIEW_LEVELS_TOP_DOWN } from '../../types';
import { CliError } from '../cli-error';
import { CommandResult } from '../command-result';
import { ReviewSession } from '../review-session';

interface ChangeEntry {
    id: string;
    isWholeFile: boolean;
    startLine: number | null;
    endLine: number | null;
    lineCount: number;
    label: string | null;
}

interface LevelEntry {
    level: string;
    changes: ChangeEntry[];
}

function place(change: ChangeEntry): string {
    if (change.isWholeFile) {
        return 'whole file';
    }
    return change.endLine === null ? `before line ${change.startLine}` : `lines ${change.startLine}-${change.endLine}`;
}

function describe(change: ChangeEntry): string {
    return `    ${place(change)}${change.label ? ` (${change.label})` : ''}  ${change.id}`;
}

export async function reportChanges(session: ReviewSession, file: string): Promise<CommandResult> {
    const repoPath = session.resolveRepoPath(file);
    const state = session.file(repoPath);
    if (!state) {
        throw new CliError('not-changed', `git does not report "${repoPath}" as changed, so it has no review levels`);
    }
    const levels: LevelEntry[] = [];
    for (const level of REVIEW_LEVELS_TOP_DOWN) {
        const document = await session.levelDocument(repoPath, level);
        levels.push({
            level,
            changes: document.changes.map(change => {
                const isWholeFile = change.id === fileChangeId();
                return {
                    id: change.id,
                    isWholeFile,
                    startLine: isWholeFile ? null : change.line + 1,
                    endLine: !isWholeFile && change.lineCount > 0 ? change.line + change.lineCount : null,
                    lineCount: change.lineCount,
                    label: change.label,
                };
            }),
        });
    }
    const total = levels.reduce((count, entry) => count + entry.changes.length, 0);
    const text = [
        `${repoPath} (${state.scanned.kind}), ${total} changes`,
        ...levels.flatMap(entry => [
            `  ${entry.level.padEnd(9)} ${entry.changes.length} changes`,
            ...entry.changes.map(describe),
        ]),
    ].join('\n');
    return {
        data: {
            command: 'changes',
            path: repoPath,
            kind: state.scanned.kind,
            head: session.head,
            changes: total,
            levels,
        },
        text,
    };
}
