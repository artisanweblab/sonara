import * as vscode from 'vscode';
import { ReviewServiceHolder } from '../review-service-holder';

export class ReviewStatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly subscription: vscode.Disposable;

    constructor(private readonly holder: ReviewServiceHolder, focusCommand: string) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
        this.item.command = focusCommand;
        this.item.tooltip = 'Show Sonara Review';
        this.subscription = holder.onDidChange(() => this.update());
        this.update();
    }

    private update(): void {
        const service = this.holder.get();
        if (!service || !service.isActive()) {
            this.item.hide();
            return;
        }
        const count = service.getAtomsByLevel().get('new')?.length ?? 0;
        this.item.text = `Review: ${count} new`;
        this.item.show();
    }

    dispose(): void {
        this.subscription.dispose();
        this.item.dispose();
    }
}
