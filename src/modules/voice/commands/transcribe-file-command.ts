import * as path from 'path';
import * as vscode from 'vscode';

import { CommandDeps } from './types';
import { LANGUAGE_LABELS, VOICE_CONFIG_SECTION, VOICE_DEFAULTS } from '../constants';
import { buildLanguageQuickPickItems } from '../language-picker';
import {
    formatTimestampForFileName,
    formatTranscriptMarkdown,
    sanitizeFileName,
} from '../webview/voice-transcripts/transcript-formatter';
import { formatDateTime, formatDuration } from '../../../shared/date-format';
import { buildInitialPrompt, loadVocabularyFromFile } from '../webview/voice-log/vocabulary-store';
import { transcriptsDir, vocabularyFile, ensureSonaraProject } from '../../../shared/project-layout';
import { atomicWrite, openInEditor } from '../../../shared/fs-utils';
import { TranscriptionCancelledError } from '../server/api-client';

const MEDIA_FILTERS = {
    'Audio / Video': ['mp3', 'mp4', 'mkv', 'webm', 'wav', 'm4a', 'flac', 'ogg', 'mov', 'avi', 'aac', 'opus'],
    'All Files': ['*'],
};

export function registerTranscribeFileCommand(deps: CommandDeps): vscode.Disposable {
    return vscode.commands.registerCommand('sonara.voice.transcribeFile', async () => {
        const { server, apiClient, activeProject, extensionLog, getTranscriptStore } = deps;

        if (!(await server.ensureRunning())) {
            return;
        }

        const folder = activeProject.get();
        if (!folder) {
            vscode.window.showInformationMessage('Open a folder to use voice features.');
            return;
        }
        const transcriptStore = getTranscriptStore();

        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Transcribe',
            filters: MEDIA_FILTERS,
            title: 'Select audio or video file to transcribe',
        });
        if (!picked || picked.length === 0) {
            return;
        }
        const sourcePath = picked[0].fsPath;
        const sourceName = path.basename(sourcePath);

        ensureSonaraProject(folder);
        const outputDir = transcriptsDir(folder);
        const vocabulary = loadVocabularyFromFile(vocabularyFile(folder));
        const initialPrompt = buildInitialPrompt(vocabulary);

        const existing = await transcriptStore.list();
        const duplicate = existing.find(item => item.sourceName === sourceName);
        if (duplicate) {
            const answer = await vscode.window.showWarningMessage(
                `"${sourceName}" was already transcribed on ${formatDateTime(new Date(duplicate.createdAt))}. Transcribe again?`,
                { modal: true },
                'Transcribe again',
            );
            if (answer !== 'Transcribe again') {
                return;
            }
        }

        const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);
        const configuredLanguage = config.get<string>('language', VOICE_DEFAULTS.language);
        const model = config.get<string>('model', VOICE_DEFAULTS.model);

        const languagePick = await vscode.window.showQuickPick(
            buildLanguageQuickPickItems(configuredLanguage, '(default)'),
            {
                placeHolder: `Language for "${sourceName}" (default: ${LANGUAGE_LABELS[configuredLanguage] ?? configuredLanguage})`,
                title: 'Select transcription language for this file',
            },
        );
        if (!languagePick || !languagePick.value) {
            return;
        }
        const selectedLanguage = languagePick.value;
        const language = selectedLanguage === 'auto' ? null : selectedLanguage;

        const now = new Date();
        const timestamp = formatTimestampForFileName(now);
        const baseName = sanitizeFileName(sourceName);
        const outputFileName = `${timestamp}_${baseName}.md`;
        const outputPath = path.join(outputDir, outputFileName);

        try {
            const abortController = new AbortController();
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Transcribing "${sourceName}"...`,
                    cancellable: true,
                },
                async (progress, token) => {
                    progress.report({ message: 'Starting...' });
                    const cancellationSubscription = token.onCancellationRequested(() => {
                        abortController.abort();
                    });

                    let lastPercent = 0;
                    try {
                        return await apiClient.transcribeFile(sourcePath, language, (p) => {
                            if (!p.totalSec) {
                                progress.report({ message: `Processed ${p.currentSec.toFixed(0)}s` });
                                return;
                            }
                            const percent = Math.min(100, Math.round((p.currentSec / p.totalSec) * 100));
                            const increment = Math.max(0, percent - lastPercent);
                            lastPercent = percent;
                            progress.report({
                                message: `${percent}% (${formatDuration(p.currentSec, 'short')} / ${formatDuration(p.totalSec, 'short')})`,
                                increment,
                            });
                        }, initialPrompt, abortController.signal);
                    } finally {
                        cancellationSubscription.dispose();
                    }
                },
            );

            const markdown = formatTranscriptMarkdown(result.segments, {
                source: sourceName,
                createdAt: now.toISOString(),
                durationSec: result.durationSec,
                language: result.language,
                processingTimeSec: result.processingTimeSec,
                model,
            });

            await atomicWrite(outputPath, markdown);
            transcriptStore.refresh();
            extensionLog.appendLine(`[Transcribe] Saved ${outputPath}`);

            const choice = await vscode.window.showInformationMessage(
                `Transcript saved: ${outputFileName}`,
                'Open',
            );
            if (choice === 'Open') {
                await openInEditor(outputPath);
            }
        } catch (err) {
            if (err instanceof TranscriptionCancelledError) {
                extensionLog.appendLine(`[Transcribe] Cancelled by user: ${sourceName}`);
                vscode.window.showInformationMessage('Transcription cancelled.');
                return;
            }
            const message = err instanceof Error ? err.message : String(err);
            extensionLog.appendLine(`[Transcribe] Failed: ${message}`);
            vscode.window.showErrorMessage(`Transcribe failed: ${message}`);
        }
    });
}
