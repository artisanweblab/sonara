import * as vscode from 'vscode';
import { registerVoiceCommand } from './voice-command';

import { CommandDeps } from './types';

export function registerLogCommands(deps: CommandDeps): void {
    const { extensionContext, voiceLogPanel } = deps;

    function currentLogStore() {
        return voiceLogPanel.getCurrentLogStore();
    }

    extensionContext.subscriptions.push(
        registerVoiceCommand(deps, 'sonara.voice.showLog', () => {
            vscode.commands.executeCommand('sonara.voice.log.focus');
        }),

        registerVoiceCommand(deps, 'sonara.voice.toggleShowAll.expand', () => {
            voiceLogPanel.toggleShowAll();
        }),
        registerVoiceCommand(deps, 'sonara.voice.toggleShowAll.collapse', () => {
            voiceLogPanel.toggleShowAll();
        }),

        registerVoiceCommand(deps, 'sonara.voice.clearProjectLog', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'Clear all voice log records for this project?',
                { modal: true },
                'Clear All'
            );
            if (confirm === 'Clear All') {
                await currentLogStore().clear();
            }
        }),
    );
}
