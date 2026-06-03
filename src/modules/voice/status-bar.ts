import * as vscode from 'vscode';
import { ServerManager, ServerStatus } from './server/server-manager';
import { AudioRecorder, RecorderState } from './audio/audio-recorder';
import { LogStore } from './webview/voice-log/log-store';
import { TranscribingState } from './commands/recording-commands';

export class StatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];
    private logStore: LogStore;
    private logStoreSubscriptions: vscode.Disposable[] = [];
    private transcribingState: TranscribingState | null = null;

    constructor(
        private readonly server: ServerManager,
        private readonly recorder: AudioRecorder,
        logStore: LogStore,
    ) {
        this.logStore = logStore;
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.item.command = 'sonara.voice.toggleRecording';
        this.item.show();

        this.disposables.push(
            server.onStatusChanged(() => this.update()),
            recorder.onStateChanged(() => this.update()),
        );

        this.subscribeToLogStore();
        this.update();
    }

    attachTranscribingState(state: TranscribingState): void {
        this.transcribingState = state;
        this.disposables.push(state.onChanged(() => this.update()));
        this.update();
    }

    updateLogStore(logStore: LogStore): void {
        this.logStore = logStore;
        this.logStoreSubscriptions.forEach(d => d.dispose());
        this.logStoreSubscriptions = [];
        this.subscribeToLogStore();
        this.update();
    }

    private subscribeToLogStore(): void {
        this.logStoreSubscriptions.push(
            this.logStore.onRecordAdded(() => this.update()),
            this.logStore.onRecordDeleted(() => this.update()),
        );
    }

    private update(): void {
        const recorderState = this.recorder.state;
        const serverStatus = this.server.status;
        const isTranscribing = this.transcribingState?.isActive === true;

        if (recorderState === 'starting' || recorderState === 'recording') {
            this.item.text = '$(record) Voice: Recording';
            this.item.tooltip = 'Recording - click or press Ctrl+Shift+M to stop, Ctrl+Alt+M to cancel';
            this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            return;
        }

        if (recorderState === 'finishing') {
            this.item.text = '$(record) Voice: Finishing';
            this.item.tooltip = 'Capturing the last second before stopping...';
            this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            return;
        }

        if (isTranscribing || recorderState === 'processing') {
            this.item.text = '$(loading~spin) Voice: Transcribing';
            this.item.tooltip = 'Sending audio to Whisper, please wait...';
            this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            return;
        }

        this.item.backgroundColor = undefined;

        switch (serverStatus) {
            case 'stopped':
                this.item.text = '$(mic) Voice: Stopped';
                this.item.tooltip = 'Voice server is not running';
                break;

            case 'starting':
                this.item.text = '$(loading~spin) Voice: Loading';
                this.item.tooltip = 'Starting Whisper server...';
                break;

            case 'ready': {
                const count = this.logStore.recordCount;
                this.item.text = `$(mic) Voice: ${count}`;
                this.item.tooltip = `${count} voice record${count !== 1 ? 's' : ''} - click to start recording (Ctrl+Shift+M)`;
                break;
            }

            case 'error':
                this.item.text = '$(warning) Voice: Error';
                this.item.tooltip = 'Voice server error - click to view log';
                this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                break;
        }
    }

    dispose(): void {
        this.item.dispose();
        this.disposables.forEach(d => d.dispose());
        this.logStoreSubscriptions.forEach(d => d.dispose());
    }
}
