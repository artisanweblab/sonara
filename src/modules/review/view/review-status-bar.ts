import * as vscode from 'vscode';
import { ReviewServices } from '../review-services';

export class ReviewStatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly subscription: vscode.Disposable;

    constructor(private readonly services: ReviewServices, focusCommand: string) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
        this.item.command = focusCommand;
        this.item.tooltip = 'Show Sonara Review';
        this.subscription = services.onDidChange(() => this.update());
        this.update();
    }

    private update(): void {
        const active = this.services.all().filter(service => service.isActive());
        if (active.length === 0) {
            this.item.hide();
            return;
        }
        const count = active.reduce((sum, service) => sum + (service.getAtomsByLevel().get('new')?.length ?? 0), 0);
        this.item.text = `Review: ${count} new`;
        this.item.show();
    }

    dispose(): void {
        this.subscription.dispose();
        this.item.dispose();
    }
}
