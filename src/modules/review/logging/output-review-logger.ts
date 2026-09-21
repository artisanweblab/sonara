import * as vscode from 'vscode';
import { currentTimestamp } from '../../../shared/timestamped-channel';
import { describeError } from '../../../shared/error-description';
import { ReviewLogger } from './review-logger';

const FLUSH_DELAY_MS = 100;
const FLUSH_LINES = 2000;

export class OutputReviewLogger implements ReviewLogger, vscode.Disposable {
    private lines: string[] = [];
    private timer: NodeJS.Timeout | undefined;

    constructor(
        private readonly channel: vscode.OutputChannel,
        private readonly isDebugEnabled: () => boolean,
    ) {}

    info(message: string): void {
        this.lines.push(`${currentTimestamp()} ${message}`);
        if (this.lines.length >= FLUSH_LINES) {
            this.flush();
        } else if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
        }
    }

    debug(message: string): void {
        if (this.isDebugEnabled()) {
            this.info(message);
        }
    }

    error(message: string, error: unknown): void {
        this.info(`ERROR ${message}: ${describeError(error)}`);
    }

    flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        if (this.lines.length === 0) {
            return;
        }
        this.channel.append(`${this.lines.join('\n')}\n`);
        this.lines = [];
    }

    dispose(): void {
        this.flush();
    }
}
