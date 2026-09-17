import { diffSegments, splitSegments } from '../../model/line-diff';
import { ReviewLevel } from '../../types';
import { CliError } from '../cli-error';
import { CommandResult } from '../command-result';
import { encodeContent } from '../level-content';
import { ReviewSession } from '../review-session';
import { UnifiedDiff } from '../unified-diff';

export async function reportDiff(session: ReviewSession, file: string, level: ReviewLevel): Promise<CommandResult> {
    const repoPath = session.resolveRepoPath(file);
    const state = session.file(repoPath);
    if (!state) {
        throw new CliError('not-changed', `git does not report "${repoPath}" as changed, so it has no review levels`);
    }
    const document = await session.levelDocument(repoPath, level);
    const isText = state.scanned.kind === 'text';
    const encoding = isText && [document.before, document.after].every(side => encodeContent(side).encoding === 'utf-8') ? 'utf-8' : 'latin1';
    const before = splitSegments(document.before);
    const after = splitSegments(document.after);
    const diff = isText
        ? UnifiedDiff.render(repoPath, before, after, diffSegments(before, after))
        : document.changes.map(change => `${repoPath}: ${change.label ?? 'changed'}\n`).join('');
    return {
        data: {
            command: 'diff',
            path: repoPath,
            level,
            kind: state.scanned.kind,
            head: session.head,
            changes: document.changes.length,
            isUnifiedDiff: isText,
            encoding: isText ? encoding : 'utf-8',
            diff,
        },
        text: diff === '' ? `no changes on ${level} in ${repoPath}` : diff.replace(/\n$/, ''),
    };
}
