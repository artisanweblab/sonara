export interface ReviewLogger {
    info(message: string): void;
    debug(message: string): void;
    error(message: string, error: unknown): void;
}

export function summarizeGitArgs(args: readonly string[]): string {
    const separator = args.indexOf('--');
    if (separator < 0) {
        return args.join(' ');
    }
    const options = args.slice(0, separator);
    const pathspecs = args.slice(separator + 1);
    const shown = pathspecs.length <= 3 ? pathspecs.join(' ') : `<${pathspecs.length} pathspecs>`;
    return `${options.join(' ')} -- ${shown}`;
}
