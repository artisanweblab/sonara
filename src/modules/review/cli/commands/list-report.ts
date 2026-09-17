import { ReviewLevel } from '../../types';
import { CommandResult } from '../command-result';
import { ReviewSession } from '../review-session';

export function reportList(session: ReviewSession, level: ReviewLevel): CommandResult {
    const files = session.files()
        .map(file => ({ path: file.path, changes: file.atoms.filter(state => state.level === level).length }))
        .filter(file => file.changes > 0);
    const changes = files.reduce((total, file) => total + file.changes, 0);
    const text = files.length === 0
        ? `no files on ${level}`
        : files.map(file => `${String(file.changes).padStart(4)}  ${file.path}`).join('\n');
    return {
        data: {
            command: 'list',
            level,
            repositoryRoot: session.repositoryRoot,
            head: session.head,
            files,
            changes,
        },
        text,
    };
}
