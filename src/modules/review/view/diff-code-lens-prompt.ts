import * as vscode from 'vscode';
import { ReviewLogger } from '../logging/review-logger';

const DISMISSED_KEY = 'sonara.review.diffCodeLensPromptDismissed';
const ENABLE_ACTION = 'Enable CodeLens in diffs';

export class DiffCodeLensPrompt {
    private isShownThisSession = false;

    constructor(
        private readonly state: vscode.Memento,
        private readonly logger: ReviewLogger,
    ) {}

    async showIfNeeded(): Promise<void> {
        if (this.isShownThisSession || this.state.get<boolean>(DISMISSED_KEY, false)) {
            return;
        }
        const configuration = vscode.workspace.getConfiguration('diffEditor');
        if (configuration.get<boolean>('codeLens', false)) {
            return;
        }
        this.isShownThisSession = true;
        const choice = await vscode.window.showInformationMessage(
            'Sonara Review: the Move Up and Move Down buttons above each change need CodeLens in diff editors, which VS Code turns off by default. The arrow buttons in the editor title move the change under the cursor without it.',
            ENABLE_ACTION,
        );
        if (choice === ENABLE_ACTION) {
            await configuration.update('codeLens', true, vscode.ConfigurationTarget.Global);
            this.logger.info('CodeLens prompt: diffEditor.codeLens enabled globally by the owner');
            return;
        }
        await this.state.update(DISMISSED_KEY, true);
        this.logger.info('CodeLens prompt dismissed, it will not be shown again');
    }
}
