import { ContentLoader, gitlinkWorktreeState } from '../git/content-loader';
import { DiffParser } from '../git/diff-parser';
import { DIFF_FLAGS, literal } from '../git/diff-options';
import { GitReader } from '../git/git-reader';
import { IndexTarget } from '../git/index-target';
import { ReviewLogger } from '../logging/review-logger';
import { GITLINK_MODE, MISSING_MODE, UNMERGED_STATE } from '../model/file-state';
import { MoveCommand, MoveOutcome, PreparedMove, preparedOutcome, refused, stale, unresolvedMessage } from './move-outcome';

export class SpecialFileMover {
    constructor(
        private readonly reader: GitReader,
        private readonly loader: ContentLoader,
        private readonly logger: ReviewLogger,
    ) {}

    async prepare(command: MoveCommand, head: string): Promise<PreparedMove> {
        const { file, source, target, generation } = command;
        const done = (outcome: MoveOutcome): PreparedMove => preparedOutcome(outcome, generation);
        this.logger.info(`Move ${file.path}: whole-file move ${source} -> ${target}`);
        if (file.worktreeState.startsWith('directory:')) {
            return done(refused(`${file.path}: this is a nested git repository. Add it with git or the Source Control view.`));
        }
        if (file.isUnreadable) {
            return done(refused(`${file.path}: the file cannot be read, so it cannot be staged from Review. Check its permissions.`));
        }
        const unstage = source === 'staged' && target === 'new';
        if (target !== 'staged' && !unstage) {
            return done(refused(`${file.path}: this change can only be staged or unstaged as a whole.`));
        }
        const index = await this.loader.indexSide(file.path);
        if (head !== generation.head || index.state !== generation.index) {
            return done(stale(head !== generation.head ? 'HEAD changed' : 'the staged version changed'));
        }
        if (unstage) {
            if (index.state === UNMERGED_STATE) {
                return done(refused(unresolvedMessage(file.path)));
            }
            const entry = await this.loader.headEntry(file.path, head);
            return this.write(command, entry ? { kind: 'object', mode: entry.mode, objectId: entry.objectId } : { kind: 'remove' });
        }
        if (generation.worktree.startsWith(`${GITLINK_MODE}:`) || index.mode === GITLINK_MODE) {
            const worktreeState = await this.gitlinkState(file.path, index.state);
            if (worktreeState !== generation.worktree) {
                return done(stale('the submodule commit changed'));
            }
            const objectId = worktreeState.slice(GITLINK_MODE.length + 1);
            return this.write(command, worktreeState === MISSING_MODE ? { kind: 'remove' } : { kind: 'object', mode: GITLINK_MODE, objectId });
        }
        const worktree = await this.loader.worktree(file.path, index.state === UNMERGED_STATE ? index.conflictMode : index.mode);
        if (worktree.state !== generation.worktree) {
            return done(stale('the working file changed'));
        }
        return this.write(command, worktree.mode === MISSING_MODE ? { kind: 'remove' } : { kind: 'blob', mode: worktree.mode, content: worktree.content ?? Buffer.alloc(0) });
    }

    private write(command: MoveCommand, indexTarget: IndexTarget): PreparedMove {
        return { outcome: null, indexTarget, generation: command.generation };
    }

    private async gitlinkState(repoPath: string, indexState: string): Promise<string> {
        const parser = new DiffParser();
        await this.reader.stream(['diff', ...DIFF_FLAGS, '--', literal(repoPath)], '\n', line => parser.push(line));
        return gitlinkWorktreeState(parser.finish().find(change => change.path === repoPath), indexState);
    }
}
