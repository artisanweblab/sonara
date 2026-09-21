import * as vscode from 'vscode';
import { registerVoiceCommand } from './voice-command';

import { CommandDeps } from './types';
import { vocabularyFile, ensureSonaraProject } from '../../../shared/project-layout';
import { openInEditor } from '../../../shared/fs-utils';

export function registerVocabularyCommands(deps: CommandDeps): void {
    const { extensionContext, activeProject } = deps;

    extensionContext.subscriptions.push(
        registerVoiceCommand(deps, 'sonara.voice.editVocabulary', async () => {
            const folder = activeProject.get();
            if (!folder) {
                vscode.window.showInformationMessage('Open a folder to use voice features.');
                return;
            }
            ensureSonaraProject(folder);
            await openInEditor(vocabularyFile(folder));
        }),
    );
}
