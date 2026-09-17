import * as vscode from 'vscode';
import { ReviewService } from './review-service';

export class ReviewServiceHolder implements vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.emitter.event;

    private service: ReviewService | undefined;
    private subscription: vscode.Disposable | undefined;

    get(): ReviewService | undefined {
        return this.service;
    }

    set(service: ReviewService | undefined): void {
        this.subscription?.dispose();
        this.service?.dispose();
        this.service = service;
        this.subscription = service?.onDidChange(() => this.emitter.fire());
        this.emitter.fire();
    }

    dispose(): void {
        this.subscription?.dispose();
        this.service?.dispose();
        this.emitter.dispose();
    }
}
