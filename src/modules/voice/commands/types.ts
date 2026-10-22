import * as vscode from 'vscode';
import { SonaraProject } from '../../../shared/sonara-project';
import { ServerManager } from '../server/server-manager';
import { AudioRecorder } from '../audio/audio-recorder';
import { ApiClient } from '../server/api-client';
import { LogStore } from '../webview/voice-log/log-store';
import { VoiceLogPanel } from '../webview/voice-log/panel';
import { TranscriptStore } from '../webview/voice-transcripts/transcript-store';
import { ActiveProject } from '../../../shared/active-project';

export interface CommandDeps {
    readonly extensionContext: vscode.ExtensionContext;
    readonly server: ServerManager;
    readonly recorder: AudioRecorder;
    readonly apiClient: ApiClient;
    readonly voiceLogPanel: VoiceLogPanel;
    readonly extensionLog: vscode.OutputChannel;
    readonly serverLog: vscode.OutputChannel;
    readonly globalStorageDir: string;
    readonly activeProject: ActiveProject;
    readonly logStoreFor: (folder: SonaraProject) => LogStore;
    readonly getTranscriptStore: () => TranscriptStore;
}
