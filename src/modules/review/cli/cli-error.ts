export type CliErrorCode =
    | 'usage'
    | 'no-repository'
    | 'not-changed'
    | 'unknown-level'
    | 'review-data-changing';

const EXIT_CODES: Readonly<Record<CliErrorCode, number>> = {
    usage: 1,
    'no-repository': 3,
    'not-changed': 2,
    'unknown-level': 2,
    'review-data-changing': 4,
};

export class CliError extends Error {
    readonly exitCode: number;

    constructor(
        readonly code: CliErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'CliError';
        this.exitCode = EXIT_CODES[code];
    }
}
