import { ReviewLogger, summarizeGitArgs } from '../logging/review-logger';
import { runGit } from './git-process';

function isAllowed(args: readonly string[]): boolean {
    const [subcommand, ...rest] = args;
    switch (subcommand) {
        case 'hash-object':
            return (rest.length === 3 && rest[0] === '-w' && rest[1] === '--stdin' && (rest[2] === '--no-filters' || rest[2].startsWith('--path=')))
                || (rest.length === 3 && rest[0] === '-w' && rest[1] === '--no-filters' && rest[2] === '--stdin-paths');
        case 'ls-files':
            return rest.length >= 5 && rest[0] === '-s' && rest[1] === '-v' && rest[2] === '-z' && rest[3] === '--';
        case 'update-index':
            return rest.length === 2 && rest[0] === '-z' && rest[1] === '--index-info';
        default:
            return false;
    }
}

export class IndexGit {
    constructor(
        private readonly repoRoot: string,
        private readonly gitPath: string,
        private readonly logger: ReviewLogger,
    ) {}

    async run(args: readonly string[], env: Readonly<Record<string, string>>, stdin: Buffer | null): Promise<Buffer> {
        if (!isAllowed(args)) {
            throw new Error(`Sonara Review: git ${args.join(' ')} is not allowed for index writes`);
        }
        const startedAt = Date.now();
        try {
            const result = await runGit(this.gitPath, this.repoRoot, args, { env, stdin: stdin ?? undefined });
            this.logger.debug(`index write: git ${summarizeGitArgs(args)} exit=0 ${Date.now() - startedAt}ms`);
            return result.stdout;
        } catch (error) {
            this.logger.info(`index write: git ${summarizeGitArgs(args)} failed after ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
}
