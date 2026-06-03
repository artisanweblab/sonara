import * as vscode from 'vscode';

import { ServerManager } from './server/server-manager';
import { SetupWizard } from './server/setup-wizard';
import { AudioRecorder } from './audio/audio-recorder';
import { createRecorderBackend } from './audio/backends';
import { ApiClient } from './server/api-client';
import { LogStore } from './webview/voice-log/log-store';
import { VoiceLogPanel } from './webview/voice-log/panel';
import { TranscriptStore } from './webview/voice-transcripts/transcript-store';
import { VoiceTranscriptsPanel } from './webview/voice-transcripts/panel';
import { StatusBar } from './status-bar';
import { CommandDeps } from './commands/types';
import { registerRecordingCommands } from './commands/recording-commands';
import { registerLogCommands } from './commands/log-commands';
import { registerModelCommands } from './commands/model-commands';
import { registerAudioInputCommands } from './commands/audio-input-commands';
import { registerServerCommands } from './commands/server-commands';
import { registerTranscribeFileCommand } from './commands/transcribe-file-command';
import { registerVocabularyCommands } from './commands/vocabulary-commands';
import { createTimestampedOutputChannel } from '../../shared/timestamped-channel';
import { ActiveProject } from '../../shared/active-project';
import { voiceLogFile, transcriptsDir } from '../../shared/project-layout';

/** All command IDs declared in package.json that live inside registerVoiceModule. */
const VOICE_COMMAND_IDS: readonly string[] = [
    'sonara.voice.toggleRecording',
    'sonara.voice.startRecording',
    'sonara.voice.stopRecording',
    'sonara.voice.cancelRecording',
    'sonara.voice.toggleStreamingMode',
    'sonara.voice.changeModel',
    'sonara.voice.changeLanguage',
    'sonara.voice.changeDevice',
    'sonara.voice.downloadModel',
    'sonara.voice.changeAudioInput',
    'sonara.voice.showLog',
    'sonara.voice.log.refresh',
    'sonara.voice.toggleShowAll.expand',
    'sonara.voice.toggleShowAll.collapse',
    'sonara.voice.clearProjectLog',
    'sonara.voice.transcripts.refresh',
    'sonara.voice.restartServer',
    'sonara.voice.showServerLogs',
    'sonara.voice.showExtensionLogs',
    'sonara.voice.editVocabulary',
    'sonara.voice.transcribeFile',
];

/**
 * Registers no-op stubs for all voice commands so that keyboard shortcuts and
 * the command palette show a clear error instead of "command not found" when
 * the extension setup was skipped or failed.
 */
function registerVoiceCommandStubs(context: vscode.ExtensionContext): void {
    for (const id of VOICE_COMMAND_IDS) {
        context.subscriptions.push(
            vscode.commands.registerCommand(id, () => {
                vscode.window.showWarningMessage(
                    'Voice setup is not completed. Run the Sonara setup wizard to activate voice features.'
                );
            }),
        );
    }
}

// M5: Returns the ServerManager so extension.ts can perform a graceful
// shutdown in deactivate().  Returns null when setup was skipped/failed.
export async function registerVoiceModule(
    context: vscode.ExtensionContext,
    activeProject: ActiveProject,
): Promise<ServerManager | null> {
    const extensionLog = createTimestampedOutputChannel('Sonara Voice');
    const serverLog = createTimestampedOutputChannel('Sonara Voice — Server');
    context.subscriptions.push(extensionLog, serverLog);

    const setup = new SetupWizard(context);
    if (!(await setup.isReady())) {
        const ok = await setup.runFirstTimeSetup();
        if (!ok) {
            extensionLog.appendLine('[Extension] Setup skipped or failed. Extension inactive.');
            registerVoiceCommandStubs(context);
            return null;
        }
    }

    await setup.checkSystemDependencies();

    const server = new ServerManager(context, extensionLog, serverLog);
    context.subscriptions.push(server);
    server.start().catch(err => {
        extensionLog.appendLine(`[Extension] Server start error: ${err}`);
    });

    const apiClient = new ApiClient();
    server.onStatusChanged(status => {
        if (status === 'ready') {
            apiClient.configure(server.port!, server.token);
        }
    });

    const globalStorageDir = context.globalStorageUri.fsPath;

    const logStoreCache = new Map<string, LogStore>();
    const emptyLogStore = new LogStore(null);

    function logStoreFor(folder: vscode.WorkspaceFolder): LogStore {
        const key = folder.uri.toString();
        let store = logStoreCache.get(key);
        if (!store) {
            store = new LogStore(voiceLogFile(folder));
            logStoreCache.set(key, store);
        }
        return store;
    }

    function currentLogStore(): LogStore {
        const folder = activeProject.get();
        return folder ? logStoreFor(folder) : emptyLogStore;
    }

    const initialFolder = activeProject.get();
    const initialLogStore = currentLogStore();
    const initialTranscriptsDir = initialFolder ? transcriptsDir(initialFolder) : null;

    const recorder = new AudioRecorder(createRecorderBackend(context));
    context.subscriptions.push(recorder);

    const voiceLogPanel = new VoiceLogPanel(initialLogStore, context.extensionUri, activeProject, logStoreFor);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('sonara.voice.log', voiceLogPanel, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        voiceLogPanel,
    );

    const initialTranscriptStore = new TranscriptStore(initialTranscriptsDir);
    const voiceTranscriptsPanel = new VoiceTranscriptsPanel(initialTranscriptStore, context.extensionUri, activeProject);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('sonara.voice.transcripts', voiceTranscriptsPanel, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        voiceTranscriptsPanel,
    );

    const statusBar = new StatusBar(server, recorder, initialLogStore);
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        activeProject.onDidChange(() => {
            statusBar.updateLogStore(currentLogStore());
        }),
    );

    context.subscriptions.push(
        recorder.onStateChanged(state => {
            if (state === 'idle') {
                vscode.commands.executeCommand('setContext', 'sonara.voice.isRecording', false);
            }
        }),
    );

    const deps: CommandDeps = {
        extensionContext: context,
        server,
        recorder,
        apiClient,
        voiceLogPanel,
        extensionLog,
        serverLog,
        globalStorageDir,
        activeProject,
        logStoreFor,
        getTranscriptStore: () => voiceTranscriptsPanel.getCurrentStore(),
    };

    const transcribingState = registerRecordingCommands(deps);
    statusBar.attachTranscribingState(transcribingState);
    registerLogCommands(deps);
    registerModelCommands(deps);
    registerAudioInputCommands(deps);
    registerServerCommands(deps);
    registerVocabularyCommands(deps);

    context.subscriptions.push(
        vscode.commands.registerCommand('sonara.voice.log.refresh', () => voiceLogPanel.forceRefresh()),
        vscode.commands.registerCommand('sonara.voice.transcripts.refresh', () => voiceTranscriptsPanel.forceRefresh()),
        registerTranscribeFileCommand(deps),
    );

    if (vscode.workspace.getConfiguration('sonara.voice.log').get<boolean>('autoOpenPanel', false)) {
        vscode.commands.executeCommand('sonara.voice.showLog');
    }

    return server;
}
