import { ReviewLevel } from '../../types';
import { CliError } from '../cli-error';
import { BinaryCommandResult } from '../command-result';
import { contentBytes, encodeContent } from '../level-content';
import { ReviewSession } from '../review-session';

export async function reportShow(session: ReviewSession, file: string, level: ReviewLevel): Promise<BinaryCommandResult> {
    const repoPath = session.resolveRepoPath(file);
    const state = session.file(repoPath);
    if (!state) {
        throw new CliError('not-changed', `git does not report "${repoPath}" as changed, so it has no review levels`);
    }
    const document = await session.levelDocument(repoPath, level);
    const encoded = encodeContent(document.after);
    return {
        data: {
            command: 'show',
            path: repoPath,
            level,
            kind: state.scanned.kind,
            head: session.head,
            ...encoded,
        },
        text: encoded.content,
        textBytes: contentBytes(document.after),
    };
}
