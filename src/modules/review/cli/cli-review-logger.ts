import { ReviewLogger, describeError } from '../logging/review-logger';

export class CliReviewLogger implements ReviewLogger {
    constructor(private readonly isVerbose: boolean) {}

    info(message: string): void {
        this.write(message);
    }

    debug(message: string): void {
        this.write(message);
    }

    error(message: string, error: unknown): void {
        this.write(`${message}: ${describeError(error)}`);
    }

    private write(message: string): void {
        if (this.isVerbose) {
            process.stderr.write(`${message}\n`);
        }
    }
}
