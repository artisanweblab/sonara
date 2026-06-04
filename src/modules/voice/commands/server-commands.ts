import * as vscode from 'vscode';

import { CommandDeps } from './types';

export function registerServerCommands(deps: CommandDeps): void {
    const { extensionContext, server, extensionLog, serverLog } = deps;

    extensionContext.subscriptions.push(
        vscode.commands.registerCommand('sonara.voice.startServer', async () => {
            await server.enable();
            const ok = await server.ensureRunning();
            if (ok) {
                vscode.window.showInformationMessage('Voice server started.');
            } else {
                vscode.window.showWarningMessage('Voice server could not be started.');
            }
        }),

        vscode.commands.registerCommand('sonara.voice.stopServer', async () => {
            await server.disable();
            vscode.window.showInformationMessage('Voice server stopped.');
        }),

        vscode.commands.registerCommand('sonara.voice.toggleServer', async () => {
            if (server.isEnabled()) {
                await server.disable();
                vscode.window.showInformationMessage('Voice server stopped.');
            } else {
                await server.enable();
                await server.ensureRunning();
                vscode.window.showInformationMessage('Voice server started.');
            }
        }),

        vscode.commands.registerCommand('sonara.voice.restartServer', async () => {
            if (!server.isEnabled()) {
                await server.enable();
            }
            await server.ensureRunning();
            await server.restart();
            vscode.window.showInformationMessage('Voice server restarted.');
        }),

        vscode.commands.registerCommand('sonara.voice.showServerLogs', () => {
            serverLog.show();
        }),

        vscode.commands.registerCommand('sonara.voice.showExtensionLogs', () => {
            extensionLog.show();
        }),
    );
}
