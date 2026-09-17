import { StringDecoder } from 'string_decoder';
import { ReviewLogger, summarizeGitArgs } from '../logging/review-logger';
import { OBJECT_ID_PATTERN } from '../model/file-state';
import { runGit } from './git-process';

const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set(['diff', 'ls-files', 'ls-tree', 'rev-parse', 'hash-object', 'cat-file', 'check-attr']);
const FORBIDDEN_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
    'hash-object': ['-w', '--stdin', '--stdin-paths'],
    diff: ['--output'],
};
const STASH_LOG = ['log', '--walk-reflogs', '--format=%H %ct %P', 'refs/stash'];
const FILE_MODE_CONFIG = ['config', '--bool', '--get', 'core.filemode'];
const AUTO_CRLF_CONFIG = ['config', '--get', 'core.autocrlf'];
const EXACT_COMMANDS: Readonly<Record<string, readonly (readonly string[])[]>> = {
    log: [STASH_LOG],
    config: [FILE_MODE_CONFIG, AUTO_CRLF_CONFIG],
};
const BATCH_FORMS: readonly (readonly string[])[] = [['--batch']];

export const STASH_LOG_ARGS = STASH_LOG;
export const FILE_MODE_CONFIG_ARGS = FILE_MODE_CONFIG;
export const AUTO_CRLF_CONFIG_ARGS = AUTO_CRLF_CONFIG;

export type RecordSeparator = '\n' | '\0';

function sameArgs(args: readonly string[], expected: readonly string[]): boolean {
    return args.length === expected.length && args.every((arg, index) => arg === expected[index]);
}

export class GitReader {
    constructor(
        private readonly cwd: string,
        private readonly logger: ReviewLogger,
        private readonly gitPath: string = 'git',
    ) {}

    async stream(
        args: readonly string[],
        separator: RecordSeparator,
        onRecord: (record: string) => void,
        allowedExitCodes: readonly number[] = [0],
        stdin?: Buffer,
    ): Promise<number> {
        this.assertReadOnly(args);
        const startedAt = Date.now();
        const decoder = new StringDecoder('utf8');
        let pending = '';
        const emit = (text: string): void => {
            pending += text;
            let index = pending.indexOf(separator);
            let offset = 0;
            while (index >= 0) {
                onRecord(pending.slice(offset, index));
                offset = index + 1;
                index = pending.indexOf(separator, offset);
            }
            pending = pending.slice(offset);
        };
        try {
            const result = await runGit(this.gitPath, this.cwd, args, { allowedExitCodes, stdin, onStdout: chunk => emit(decoder.write(chunk)) });
            emit(decoder.end());
            if (pending.length > 0) {
                onRecord(pending);
            }
            this.logExit(args, String(result.exitCode), startedAt);
            return result.exitCode;
        } catch (error) {
            this.logExit(args, 'failed', startedAt);
            throw error;
        }
    }

    async chunks(args: readonly string[], stdin: Buffer, onChunk: (chunk: Buffer) => void): Promise<void> {
        this.assertReadOnly(args);
        const startedAt = Date.now();
        try {
            await runGit(this.gitPath, this.cwd, args, { stdin, onStdout: onChunk });
            this.logExit(args, '0', startedAt);
        } catch (error) {
            this.logExit(args, 'failed', startedAt);
            throw error;
        }
    }

    async buffer(args: readonly string[]): Promise<Buffer> {
        this.assertReadOnly(args);
        const startedAt = Date.now();
        try {
            const result = await runGit(this.gitPath, this.cwd, args);
            this.logExit(args, '0', startedAt);
            return result.stdout;
        } catch (error) {
            this.logExit(args, 'failed', startedAt);
            throw error;
        }
    }

    async lines(args: readonly string[], allowedExitCodes: readonly number[] = [0]): Promise<string[]> {
        const records: string[] = [];
        await this.stream(args, '\n', record => records.push(record), allowedExitCodes);
        return records;
    }

    async nulRecords(args: readonly string[], stdin?: Buffer): Promise<string[]> {
        const records: string[] = [];
        await this.stream(args, '\0', record => {
            if (record.length > 0) {
                records.push(record);
            }
        }, [0], stdin);
        return records;
    }

    private logExit(args: readonly string[], exit: string, startedAt: number): void {
        this.logger.debug(`git ${summarizeGitArgs(args)} exit=${exit} ${Date.now() - startedAt}ms`);
    }

    private assertReadOnly(args: readonly string[]): void {
        const subcommand = args[0];
        const exact = subcommand === undefined ? undefined : EXACT_COMMANDS[subcommand];
        if (exact) {
            if (!exact.some(expected => sameArgs(args, expected))) {
                throw new Error(`Sonara Review: git ${subcommand} is allowed only as ${exact.map(expected => `"git ${expected.join(' ')}"`).join(' or ')}`);
            }
            return;
        }
        if (subcommand === undefined || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
            throw new Error(`Sonara Review: git subcommand "${subcommand ?? ''}" is not allowed`);
        }
        if (subcommand === 'cat-file') {
            this.assertCatFile(args.slice(1));
            return;
        }
        if (subcommand === 'check-attr') {
            this.assertCheckAttr(args.slice(1));
            return;
        }
        const forbidden = FORBIDDEN_ARGUMENTS[subcommand] ?? [];
        const separatorIndex = args.indexOf('--');
        const options = separatorIndex >= 0 ? args.slice(1, separatorIndex) : args.slice(1);
        for (const option of options) {
            if (forbidden.some(flag => option === flag || option.startsWith(`${flag}=`))) {
                throw new Error(`Sonara Review: git ${subcommand} option "${option}" is not allowed`);
            }
        }
    }

    private assertCatFile(options: readonly string[]): void {
        if (options.length === 2 && options[0] === 'blob' && OBJECT_ID_PATTERN.test(options[1])) {
            return;
        }
        if (BATCH_FORMS.some(form => sameArgs(options, form))) {
            return;
        }
        const flags = options.slice(0, -1);
        const isValid = options.length >= 2
            && flags.includes('--filters')
            && flags.every(flag => flag === '--filters' || flag.startsWith('--path='))
            && !options[options.length - 1].startsWith('-');
        if (!isValid) {
            throw new Error(`Sonara Review: git cat-file is allowed only with --filters or --batch: ${options.join(' ')}`);
        }
    }

    private assertCheckAttr(options: readonly string[]): void {
        const isValid = options.length >= 3 && options[0] === '-z' && options[1] === '--stdin'
            && options.slice(2).every(attribute => /^[a-z][a-z-]*$/.test(attribute));
        if (!isValid) {
            throw new Error(`Sonara Review: git check-attr is allowed only as "git check-attr -z --stdin <attributes>": ${options.join(' ')}`);
        }
    }
}
