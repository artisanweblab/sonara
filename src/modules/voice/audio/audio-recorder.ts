import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

import { VOICE_CONFIG_SECTION } from '../constants';
import { AudioInputDevice, RecorderBackend } from './backends';

export type RecorderState = 'idle' | 'recording' | 'finishing' | 'processing';
export { AudioInputDevice } from './backends';

const DEFAULT_STOP_DELAY_MS = 1000;

export interface RecordingResult {
    wavBuffer: Buffer;
    durationSec: number;
}

/**
 * Owns the recording lifecycle (state machine, timings, temp files) and
 * delegates platform-specific capture to the injected RecorderBackend.
 */
export class AudioRecorder implements vscode.Disposable {
    private process: cp.ChildProcess | null = null;
    private tempFile: string | null = null;
    private startTime: number = 0;
    private _state: RecorderState = 'idle';

    private readonly onStateChangedEmitter = new vscode.EventEmitter<RecorderState>();
    readonly onStateChanged = this.onStateChangedEmitter.event;

    constructor(private readonly backend: RecorderBackend) {}

    get state(): RecorderState {
        return this._state;
    }

    async start(): Promise<void> {
        if (this._state !== 'idle') {
            return;
        }

        this.tempFile = path.join(
            os.tmpdir(),
            `ptt_${crypto.randomBytes(8).toString('hex')}.wav`
        );

        await this.backend.ensureReady();
        const deviceId = this.getConfiguredDeviceId();
        this.process = this.backend.spawnWavToFile(this.tempFile, deviceId);

        this.process.stderr?.on('data', () => {
            // suppress backend status output
        });

        this.process.on('error', (err) => {
            this.cleanup();
            vscode.window.showErrorMessage(
                `Failed to start recorder (${this.backend.id}): ${err.message}`
            );
        });

        this.startTime = Date.now();
        this.setState('recording');
    }

    async stop(): Promise<RecordingResult> {
        if (this._state !== 'recording' || !this.process || !this.tempFile) {
            throw new Error('Not recording');
        }

        this.setState('finishing');

        const tailDelayMs = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION)
            .get<number>('stopDelayMs', DEFAULT_STOP_DELAY_MS);
        if (tailDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, tailDelayMs));
        }

        this.setState('processing');

        const tempFile = this.tempFile;
        const durationSec = (Date.now() - this.startTime) / 1000;

        await this.stopProcess();

        // Small delay to ensure file is flushed
        await new Promise(resolve => setTimeout(resolve, 100));

        if (!fs.existsSync(tempFile)) {
            this.setState('idle');
            throw new Error('Recording file not found - microphone may not be accessible');
        }

        const wavBuffer = fs.readFileSync(tempFile);
        fs.unlinkSync(tempFile);
        this.tempFile = null;

        this.setState('idle');
        return { wavBuffer, durationSec };
    }

    async startStreaming(onPcm: (chunk: Buffer) => void): Promise<void> {
        if (this._state !== 'idle') {
            return;
        }

        this.tempFile = null;

        await this.backend.ensureReady();
        const deviceId = this.getConfiguredDeviceId();
        this.process = this.backend.spawnPcmStream(deviceId);

        this.process.stdout?.on('data', (chunk: Buffer) => {
            onPcm(chunk);
        });

        this.process.stderr?.on('data', () => {
            // suppress backend status output
        });

        this.process.on('error', (err) => {
            this.cleanup();
            vscode.window.showErrorMessage(
                `Failed to start recorder (${this.backend.id}): ${err.message}`
            );
        });

        this.startTime = Date.now();
        this.setState('recording');
    }

    async stopStreaming(): Promise<{ durationSec: number }> {
        if (this._state !== 'recording' || !this.process) {
            throw new Error('Not recording');
        }

        this.setState('finishing');

        const tailDelayMs = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION)
            .get<number>('stopDelayMs', DEFAULT_STOP_DELAY_MS);
        if (tailDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, tailDelayMs));
        }

        this.setState('processing');

        const durationSec = (Date.now() - this.startTime) / 1000;
        await this.stopProcess();
        this.process = null;
        this.setState('idle');

        return { durationSec };
    }

    async cancel(): Promise<void> {
        if (this._state !== 'recording' && this._state !== 'finishing') {
            return;
        }
        const tempFile = this.tempFile;
        await this.stopProcess();
        if (tempFile && fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
        this.tempFile = null;
        this.process = null;
        this.setState('idle');
    }

    listInputDevices(): Promise<AudioInputDevice[]> {
        return this.backend.listInputDevices();
    }

    isConfiguredSourceMuted(): Promise<boolean | null> {
        return this.backend.isSourceMuted(this.getConfiguredDeviceId());
    }

    private async stopProcess(): Promise<void> {
        if (!this.process) {
            return;
        }

        return new Promise(resolve => {
            if (!this.process) {
                resolve();
                return;
            }

            const timer = setTimeout(() => {
                this.process?.kill('SIGKILL');
                resolve();
            }, 3000);

            this.process.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });

            // SIGINT lets recorders finalize the WAV header / flush buffers properly
            this.process.kill('SIGINT');
        });
    }

    private getConfiguredDeviceId(): string | null {
        const value = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION).get<string | null>('audioInput', null);
        if (!value || typeof value !== 'string') {
            return null;
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }

    private cleanup(): void {
        if (this.tempFile && fs.existsSync(this.tempFile)) {
            fs.unlinkSync(this.tempFile);
            this.tempFile = null;
        }
        this.process = null;
        this.setState('idle');
    }

    private setState(state: RecorderState): void {
        this._state = state;
        this.onStateChangedEmitter.fire(state);
    }

    dispose(): void {
        this.process?.kill('SIGKILL');
        this.cleanup();
        this.onStateChangedEmitter.dispose();
    }
}
