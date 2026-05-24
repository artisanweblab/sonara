import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

import { commandExists } from '../../../shared/command-exists';
import { VOICE_CONFIG_SECTION } from '../constants';

export type RecorderState = 'idle' | 'recording' | 'finishing' | 'processing';

const DEFAULT_STOP_DELAY_MS = 1000;

export interface RecordingResult {
    wavBuffer: Buffer;
    durationSec: number;
}

export interface AudioInputDevice {
    id: string;
    label: string;
    isDefault: boolean;
}

/**
 * Records audio via parecord (PipeWire/PulseAudio) or arecord (ALSA fallback).
 * Writes a temp WAV file, reads it on stop, then deletes it.
 */
export class AudioRecorder implements vscode.Disposable {
    private process: cp.ChildProcess | null = null;
    private tempFile: string | null = null;
    private startTime: number = 0;
    private _state: RecorderState = 'idle';

    private readonly onStateChangedEmitter = new vscode.EventEmitter<RecorderState>();
    readonly onStateChanged = this.onStateChangedEmitter.event;

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

        const recorder = await this.findRecorder();
        const deviceId = this.getConfiguredDeviceId();
        const args = this.buildArgs(recorder, this.tempFile, deviceId);

        this.process = cp.spawn(recorder, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
        });

        this.process.stderr?.on('data', () => {
            // suppress parecord/arecord status output
        });

        this.process.on('error', (err) => {
            this.cleanup();
            vscode.window.showErrorMessage(
                `Failed to start recorder (${recorder}): ${err.message}. ` +
                `Install parecord: sudo dnf install pulseaudio-utils`
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

        const recorder = await this.findRecorder();
        const deviceId = this.getConfiguredDeviceId();
        const args = this.buildStreamingArgs(recorder, deviceId);

        this.process = cp.spawn(recorder, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.process.stdout?.on('data', (chunk: Buffer) => {
            onPcm(chunk);
        });

        this.process.stderr?.on('data', () => {
            // suppress parecord/arecord status output
        });

        this.process.on('error', (err) => {
            this.cleanup();
            vscode.window.showErrorMessage(
                `Failed to start recorder (${recorder}): ${err.message}`
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

    private buildStreamingArgs(recorder: string, deviceId: string | null): string[] {
        if (recorder === 'parecord') {
            const args = [
                '--format=s16le',
                '--rate=16000',
                '--channels=1',
                '--raw',
            ];
            if (deviceId) {
                args.push(`--device=${deviceId}`);
            }
            return args;
        }
        // arecord (ALSA)
        const args = [
            '-f', 'S16_LE',
            '-r', '16000',
            '-c', '1',
            '-t', 'raw',
        ];
        if (deviceId) {
            args.push('-D', deviceId);
        }
        args.push('-');
        return args;
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

            // SIGINT causes parecord/arecord to finalize the WAV header properly
            this.process.kill('SIGINT');
        });
    }

    private async findRecorder(): Promise<string> {
        for (const cmd of ['parecord', 'arecord']) {
            if (await commandExists(cmd)) {
                return cmd;
            }
        }
        throw new Error(
            'No audio recorder found. Install parecord: sudo dnf install pulseaudio-utils'
        );
    }

    private buildArgs(recorder: string, outputFile: string, deviceId: string | null): string[] {
        if (recorder === 'parecord') {
            const args = [
                '--format=s16le',
                '--rate=16000',
                '--channels=1',
                '--file-format=wav',
            ];
            if (deviceId) {
                args.push(`--device=${deviceId}`);
            }
            args.push(outputFile);
            return args;
        }
        // arecord (ALSA)
        const args = [
            '-f', 'S16_LE',
            '-r', '16000',
            '-c', '1',
        ];
        if (deviceId) {
            args.push('-D', deviceId);
        }
        args.push(outputFile);
        return args;
    }

    private getConfiguredDeviceId(): string | null {
        const value = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION).get<string | null>('audioInput', null);
        if (!value || typeof value !== 'string') {
            return null;
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }

    async isConfiguredSourceMuted(): Promise<boolean | null> {
        if (!(await commandExists('pactl'))) {
            return null;
        }
        let source: string | null = this.getConfiguredDeviceId();
        if (!source) {
            try {
                source = (await execCapture('pactl get-default-source')).trim();
            } catch {
                return null;
            }
        }
        if (!source || !/^[A-Za-z0-9._:-]+$/.test(source)) {
            return null;
        }
        try {
            const out = await execCapture(`pactl get-source-mute ${source}`);
            const match = out.match(/Mute:\s*(yes|no)/i);
            if (!match) {
                return null;
            }
            return match[1].toLowerCase() === 'yes';
        } catch {
            return null;
        }
    }

    async listInputDevices(): Promise<AudioInputDevice[]> {
        if (!(await commandExists('pactl'))) {
            return [];
        }
        const [defaultName, listOutput] = await Promise.all([
            execCapture('pactl get-default-source').then(out => out.trim()).catch(() => ''),
            execCapture('pactl list sources').catch(() => ''),
        ]);
        if (!listOutput) {
            return [];
        }

        const devices: AudioInputDevice[] = [];
        const blocks = listOutput.split(/\n(?=Source #)/);
        for (const block of blocks) {
            const nameMatch = block.match(/^\s*Name:\s*(.+)$/m);
            if (!nameMatch) {
                continue;
            }
            const name = nameMatch[1].trim();
            // .monitor sources are loopback (system audio) - separate feature, hide for now.
            if (name.endsWith('.monitor')) {
                continue;
            }
            const descMatch = block.match(/^\s*Description:\s*(.+)$/m);
            devices.push({
                id: name,
                label: descMatch ? descMatch[1].trim() : name,
                isDefault: name === defaultName,
            });
        }
        return devices;
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

function execCapture(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.exec(command, { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(stdout);
        });
    });
}
