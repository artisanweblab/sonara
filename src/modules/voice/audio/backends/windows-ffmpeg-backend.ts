import * as cp from 'child_process';
import * as vscode from 'vscode';

import { FfmpegInstaller } from './ffmpeg-installer';
import { AudioInputDevice, RecorderBackend } from './recorder-backend';

/**
 * Windows capture via ffmpeg + DirectShow. ffmpeg is installed into the
 * extension's globalStorage by FfmpegInstaller on first use, so the user
 * does not have to manage a system-wide install.
 */
export class WindowsFfmpegBackend implements RecorderBackend {
    readonly id = 'windows-ffmpeg';
    private binPath: string | null = null;
    private cachedDevices: AudioInputDevice[] | null = null;
    private missingDeviceWarned: string | null = null;

    constructor(private readonly installer: FfmpegInstaller) {}

    async ensureReady(): Promise<void> {
        this.binPath = await this.installer.ensureInstalled();
        this.cachedDevices = await this.enumerateDevices();
    }

    spawnWavToFile(outputFile: string, deviceId: string | null): cp.ChildProcess {
        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            '-f', 'dshow',
            '-i', `audio=${this.resolveDevice(deviceId)}`,
            '-ar', '16000',
            '-ac', '1',
            '-sample_fmt', 's16',
            '-y',
            outputFile,
        ];
        return cp.spawn(this.requireBin(), args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    }

    spawnPcmStream(deviceId: string | null): cp.ChildProcess {
        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            '-f', 'dshow',
            '-i', `audio=${this.resolveDevice(deviceId)}`,
            '-ar', '16000',
            '-ac', '1',
            '-f', 's16le',
            'pipe:1',
        ];
        return cp.spawn(this.requireBin(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    }

    async listInputDevices(): Promise<AudioInputDevice[]> {
        if (!this.installer.isInstalled()) {
            return [];
        }
        if (!this.binPath) {
            this.binPath = this.installer.binaryPath();
        }
        // Always re-enumerate so the picker reflects devices plugged in/out
        // since the last call. Update cache for resolveDevice fallback.
        this.cachedDevices = await this.enumerateDevices();
        return this.cachedDevices;
    }

    async isSourceMuted(_deviceId: string | null): Promise<boolean | null> {
        // DirectShow does not expose mute state through ffmpeg. The shared
        // silence check (post-record RMS) covers the same user-facing case.
        return null;
    }

    gracefulStop(process: cp.ChildProcess): void {
        // ffmpeg exits cleanly when it reads 'q' on stdin: WAV header is
        // finalized, dshow capture is released. A hard SIGTERM/kill leaves
        // a truncated, unplayable file.
        if (process.stdin && !process.stdin.destroyed) {
            process.stdin.write('q\n', () => {
                process.stdin?.end();
            });
        } else {
            process.kill();
        }
    }

    private requireBin(): string {
        if (!this.binPath) {
            throw new Error('WindowsFfmpegBackend not ready - call ensureReady() first');
        }
        return this.binPath;
    }

    private resolveDevice(deviceId: string | null): string {
        const fallback = this.cachedDevices?.find(d => d.isDefault)?.id
            ?? this.cachedDevices?.[0]?.id
            ?? null;
        if (deviceId) {
            const exists = this.cachedDevices?.some(d => d.id === deviceId) ?? false;
            if (exists) {
                return deviceId;
            }
            if (!fallback) {
                throw new Error(
                    `Configured microphone "${deviceId}" is not available and no fallback device was detected.`,
                );
            }
            if (this.missingDeviceWarned !== deviceId) {
                this.missingDeviceWarned = deviceId;
                vscode.window.showWarningMessage(
                    `Configured microphone "${deviceId}" is no longer available. Using "${fallback}" for this session.`,
                );
            }
            return fallback;
        }
        if (!fallback) {
            throw new Error('No audio input device detected. Plug in a microphone and try again.');
        }
        return fallback;
    }

    private enumerateDevices(): Promise<AudioInputDevice[]> {
        if (!this.binPath) {
            return Promise.resolve([]);
        }
        return new Promise((resolve) => {
            const proc = cp.spawn(
                this.binPath as string,
                ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
                { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
            );
            let stderr = '';
            proc.stderr?.on('data', (chunk: Buffer) => {
                stderr += chunk.toString();
            });
            proc.on('error', () => resolve([]));
            // ffmpeg exits with a non-zero code after listing - that is expected.
            proc.on('exit', () => resolve(parseDshowDevices(stderr)));
        });
    }
}

/**
 * Extracts audio device names from `ffmpeg -list_devices true -f dshow -i dummy`
 * stderr. Layout (per device):
 *   [dshow @ 0x...] "Microphone (USB Audio)" (audio)
 *   [dshow @ 0x...]   Alternative name "@device_cm_{GUID}\wave_{GUID}"
 * We use the human-readable name as both id and label. dshow accepts it
 * directly as `-i audio=<name>`. The first listed device is marked default.
 */
function parseDshowDevices(stderr: string): AudioInputDevice[] {
    const devices: AudioInputDevice[] = [];
    const lines = stderr.split(/\r?\n/);
    let inAudioSection = false;
    for (const line of lines) {
        if (/DirectShow audio devices/i.test(line)) {
            inAudioSection = true;
            continue;
        }
        if (/DirectShow video devices/i.test(line)) {
            inAudioSection = false;
            continue;
        }
        if (!inAudioSection) {
            continue;
        }
        const match = line.match(/"([^"]+)"\s*\(audio\)/);
        if (!match) {
            continue;
        }
        const name = match[1];
        devices.push({
            id: name,
            label: name,
            isDefault: devices.length === 0,
        });
    }
    return devices;
}
