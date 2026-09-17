import { REVIEW_LEVELS, ReviewLevel } from '../types';
import { CliError } from './cli-error';

export const CLI_COMMANDS = ['levels', 'list', 'changes', 'show', 'diff', 'help'] as const;

export type CliCommand = typeof CLI_COMMANDS[number];

export type CliFormat = 'json' | 'text';

const FORMATS: readonly CliFormat[] = ['json', 'text'];

export const USAGE = `sonara-review - read the Sonara Review levels of uncommitted changes (read-only).

Commands:
  levels                          files and changes on every level
  list --level <level>            files that have changes on this level
  changes <file>                  changes of one file, level by level
  show <file> --level <level>     the file content accepted up to this level
  diff <file> --level <level>     the changes of this level alone, as a unified diff
  help                            this text

Levels, from the commit upwards: ${REVIEW_LEVELS.join(', ')}.

Options:
  --level <level>   the level a command works on
  --format <json|text>   output format, json by default
  --project <dir>   the project folder; the launcher passes it, otherwise the nearest folder above the working directory that has .vscode/sonara/review is used

Exit codes: 0 success, 1 wrong arguments, 2 unknown file or level, 3 no git repository, 4 the review data is being changed right now.`;

export class CliOptions {
    private constructor(
        readonly command: CliCommand,
        readonly format: CliFormat,
        readonly projectPath: string | null,
        readonly file: string | null,
        readonly level: ReviewLevel | null,
    ) {}

    requireLevel(): ReviewLevel {
        if (!this.level) {
            throw new CliError('usage', `"${this.command}" needs --level <${REVIEW_LEVELS.join('|')}>`);
        }
        return this.level;
    }

    requireFile(): string {
        if (!this.file) {
            throw new CliError('usage', `"${this.command}" needs a file`);
        }
        return this.file;
    }

    static parse(argv: readonly string[]): CliOptions {
        const positional: string[] = [];
        const named = new Map<string, string>();
        for (let index = 0; index < argv.length; index++) {
            const argument = argv[index];
            if (!argument.startsWith('--')) {
                positional.push(argument);
                continue;
            }
            const separator = argument.indexOf('=');
            const name = separator < 0 ? argument.slice(2) : argument.slice(2, separator);
            if (!['level', 'format', 'project'].includes(name)) {
                throw new CliError('usage', `unknown option "${argument}"`);
            }
            const value = separator < 0 ? argv[++index] : argument.slice(separator + 1);
            if (value === undefined) {
                throw new CliError('usage', `option "--${name}" needs a value`);
            }
            named.set(name, value);
        }
        const command = CLI_COMMANDS.find(candidate => candidate === (positional[0] ?? 'help'));
        if (!command) {
            throw new CliError('usage', `unknown command "${positional[0]}"`);
        }
        const format = FORMATS.find(candidate => candidate === (named.get('format') ?? 'json'));
        if (!format) {
            throw new CliError('usage', `unknown format "${named.get('format')}", use json or text`);
        }
        const level = CliOptions.readLevel(named.get('level'));
        const file = positional[1] ?? null;
        if (positional.length > 2) {
            throw new CliError('usage', `"${command}" takes one file, got ${positional.length - 1}`);
        }
        if ((command === 'changes' || command === 'show' || command === 'diff') && !file) {
            throw new CliError('usage', `"${command}" needs a file`);
        }
        if ((command === 'list' || command === 'show' || command === 'diff') && !level) {
            throw new CliError('usage', `"${command}" needs --level <${REVIEW_LEVELS.join('|')}>`);
        }
        return new CliOptions(command, format, named.get('project') ?? null, file, level);
    }

    private static readLevel(value: string | undefined): ReviewLevel | null {
        if (value === undefined) {
            return null;
        }
        const level = REVIEW_LEVELS.find(candidate => candidate === value);
        if (!level) {
            throw new CliError('unknown-level', `unknown level "${value}", use one of ${REVIEW_LEVELS.join(', ')}`);
        }
        return level;
    }
}
