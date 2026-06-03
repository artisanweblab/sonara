import * as vscode from 'vscode';

export type TickListener = (tickAt: Date) => Promise<void> | void;

export class TickService implements vscode.Disposable {
    private timer: NodeJS.Timeout | undefined;
    private flushTimer: NodeJS.Timeout | undefined;
    private busy = false;

    public constructor(
        private tickIntervalSec: number,
        private flushIntervalSec: number,
        private readonly onTick: TickListener,
        private readonly onFlush: () => Promise<void>,
    ) {}

    public reconfigure(tickIntervalSec: number, flushIntervalSec: number): void {
        const wasRunning = this.isRunning();
        if (wasRunning) {
            this.stop();
        }
        this.tickIntervalSec = tickIntervalSec;
        this.flushIntervalSec = flushIntervalSec;
        if (wasRunning) {
            this.start();
        }
    }

    public isRunning(): boolean {
        return this.timer !== undefined;
    }

    public start(): void {
        if (this.timer) return;
        const tickMs = Math.max(1, this.tickIntervalSec) * 1000;
        const flushMs = Math.max(1, this.flushIntervalSec) * 1000;
        this.timer = setInterval(() => {
            void this.runTick();
        }, tickMs);
        this.flushTimer = setInterval(() => {
            void this.onFlush();
        }, flushMs);
    }

    public stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = undefined;
        }
    }

    private async runTick(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        try {
            await this.onTick(new Date());
        } finally {
            this.busy = false;
        }
    }

    public dispose(): void {
        this.stop();
    }
}
