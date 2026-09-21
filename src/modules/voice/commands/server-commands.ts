import * as vscode from 'vscode';
import { registerVoiceCommand } from './voice-command';

import { CommandDeps } from './types';

export function registerServerCommands(deps: CommandDeps): void {
    const { extensionContext, server, extensionLog, serverLog } = deps;

    extensionContext.subscriptions.push(
        registerVoiceCommand(deps, 'sonara.voice.startServer', async () => {
            await server.enable();
            const ok = await server.ensureRunning();
            if (ok) {
                vscode.window.showInformationMessage('Voice server started.');
            } else {
                vscode.window.showWarningMessage('Voice server could not be started.');
            }
        }),

        registerVoiceCommand(deps, 'sonara.voice.stopServer', async () => {
            await server.disable();
            vscode.window.showInformationMessage('Voice server stopped.');
        }),

        registerVoiceCommand(deps, 'sonara.voice.toggleServer', async () => {
            if (server.isEnabled()) {
                await server.disable();
                vscode.window.showInformationMessage('Voice server stopped.');
            } else {
                await server.enable();
                await server.ensureRunning();
                vscode.window.showInformationMessage('Voice server started.');
            }
        }),

        registerVoiceCommand(deps, 'sonara.voice.restartServer', async () => {
            if (!server.isEnabled()) {
                await server.enable();
            }
            await server.ensureRunning();
            await server.restart();
            vscode.window.showInformationMessage('Voice server restarted.');
        }),

        registerVoiceCommand(deps, 'sonara.voice.showServerLogs', () => {
            serverLog.show();
        }),

        registerVoiceCommand(deps, 'sonara.voice.showExtensionLogs', () => {
            extensionLog.show();
        }),
    );
}
