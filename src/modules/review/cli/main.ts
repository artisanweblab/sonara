import { CliError } from './cli-error';
import { CliOptions, USAGE } from './cli-options';
import { CliReviewLogger } from './cli-review-logger';
import { BinaryCommandResult, CommandResult } from './command-result';
import { reportChanges } from './commands/changes-report';
import { reportDiff } from './commands/diff-report';
import { reportLevels } from './commands/levels-report';
import { reportList } from './commands/list-report';
import { reportShow } from './commands/show-report';
import { locateProject } from './project-locator';
import { ReviewSession } from './review-session';

function isBinary(result: CommandResult): result is BinaryCommandResult {
    return 'textBytes' in result;
}

async function runCommand(options: CliOptions, session: ReviewSession): Promise<CommandResult> {
    switch (options.command) {
        case 'levels':
            return reportLevels(session);
        case 'list':
            return reportList(session, options.requireLevel());
        case 'changes':
            return reportChanges(session, options.requireFile());
        case 'show':
            return reportShow(session, options.requireFile(), options.requireLevel());
        default:
            return reportDiff(session, options.requireFile(), options.requireLevel());
    }
}

function write(result: CommandResult, options: CliOptions, session: ReviewSession): void {
    const unreadable = session.unreadableFiles();
    if (options.format === 'json') {
        const data = unreadable.length > 0 ? { ...result.data, unreadable } : result.data;
        process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
        return;
    }
    unreadable.forEach(file => process.stderr.write(`sonara-review: ${file.path} is shown from git only, its stored levels could not be read: ${file.reason}\n`));
    if (isBinary(result) && result.textBytes) {
        process.stdout.write(result.textBytes);
        return;
    }
    process.stdout.write(`${result.text}\n`);
}

function fail(error: unknown, format: 'json' | 'text'): number {
    const code = error instanceof CliError ? error.code : 'failed';
    const message = error instanceof Error ? error.message : String(error);
    if (format === 'json') {
        process.stdout.write(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
    } else {
        process.stderr.write(`sonara-review: ${message}\n`);
    }
    return error instanceof CliError ? error.exitCode : 5;
}

async function main(): Promise<number> {
    let options: CliOptions;
    try {
        options = CliOptions.parse(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${USAGE}\n\n`);
        return fail(error, 'text');
    }
    if (options.command === 'help') {
        process.stdout.write(`${USAGE}\n`);
        return 0;
    }
    const logger = new CliReviewLogger(process.env.SONARA_REVIEW_VERBOSE === '1');
    let session: ReviewSession | undefined;
    try {
        session = await ReviewSession.open(options.projectPath ?? locateProject(process.cwd()), logger);
        const opened = session;
        write(await opened.read(() => runCommand(options, opened)), options, opened);
        return 0;
    } catch (error) {
        return fail(error, options.format);
    } finally {
        session?.dispose();
    }
}

main().then(code => {
    process.exitCode = code;
}, error => {
    process.stderr.write(`sonara-review: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 5;
});
