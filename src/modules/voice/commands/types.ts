import * as vscode from 'vscode';
import { ServerManager } from '../server/server-manager';
import { AudioRecorder } from '../audio/audio-recorder';
import { ApiClient } from '../server/api-client';
import { LogStore } from '../webview/voice-log/log-store';
import { VoiceLogPanel } from '../webview/voice-log/panel';
import { TranscriptStore } from '../webview/voice-transcripts/transcript-store';
import { ActiveProject } from '../../../shared/active-project';
import { FfmpegInstaller } from '../audio/backends';

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
    readonly logStoreFor: (folder: vscode.WorkspaceFolder) => LogStore;
    readonly getTranscriptStore: () => TranscriptStore;
    /** Present only on platforms that use a self-installed ffmpeg (Windows). */
    readonly ffmpegInstaller?: FfmpegInstaller;
}
