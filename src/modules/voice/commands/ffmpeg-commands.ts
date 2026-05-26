import * as vscode from 'vscode';

import { CommandDeps } from './types';

export function registerFfmpegCommands(deps: CommandDeps): void {
    const { extensionContext, ffmpegInstaller } = deps;

    extensionContext.subscriptions.push(
        vscode.commands.registerCommand('sonara.voice.reinstallFfmpeg', async () => {
            if (!ffmpegInstaller) {
                vscode.window.showInformationMessage(
                    'ffmpeg reinstall is only applicable on Windows. Other platforms use system audio tools.',
                );
                return;
            }
            const confirm = await vscode.window.showWarningMessage(
                'Delete the bundled ffmpeg and download it again? The next recording will trigger a fresh install.',
                { modal: true },
                'Reinstall',
            );
            if (confirm !== 'Reinstall') {
                return;
            }
            try {
                await ffmpegInstaller.wipe();
                await ffmpegInstaller.ensureInstalled();
                vscode.window.showInformationMessage('ffmpeg reinstalled.');
            } catch (err) {
                vscode.window.showErrorMessage(`ffmpeg reinstall failed: ${err}`);
            }
        }),
    );
}
