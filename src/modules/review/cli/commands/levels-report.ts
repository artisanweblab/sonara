import { REVIEW_LEVELS_TOP_DOWN, ReviewFileState, ReviewLevel } from '../../types';
import { CommandResult } from '../command-result';
import { ReviewSession } from '../review-session';

interface LevelCount {
    level: ReviewLevel;
    files: number;
    changes: number;
}

export function countLevels(files: readonly ReviewFileState[]): LevelCount[] {
    return REVIEW_LEVELS_TOP_DOWN.map(level => {
        const onLevel = files.filter(file => file.atoms.some(state => state.level === level));
        return {
            level,
            files: onLevel.length,
            changes: onLevel.reduce((total, file) => total + file.atoms.filter(state => state.level === level).length, 0),
        };
    });
}

export function reportLevels(session: ReviewSession): CommandResult {
    const files = session.files();
    const levels = countLevels(files);
    const changes = files.reduce((total, file) => total + file.atoms.length, 0);
    const text = [
        `repository ${session.repositoryRoot}, HEAD ${session.head}, ${files.length} files, ${changes} changes`,
        ...levels.map(level => `  ${level.level.padEnd(9)} ${String(level.files).padStart(5)} files ${String(level.changes).padStart(5)} changes`),
    ].join('\n');
    return {
        data: {
            command: 'levels',
            repositoryRoot: session.repositoryRoot,
            head: session.head,
            files: files.length,
            changes,
            levels,
        },
        text,
    };
}
