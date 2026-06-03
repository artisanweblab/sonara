import * as cp from 'child_process';
import * as vscode from 'vscode';

import { LinuxPulseBackend } from './linux-pulse-backend';
import { AudioInputDevice, RecorderBackend } from './recorder-backend';

export { RecorderBackend, AudioInputDevice } from './recorder-backend';

class UnsupportedPlatformBackend implements RecorderBackend {
    readonly id = 'unsupported';

    private readonly platformLabel: string;

    constructor(platform: string) {
        this.platformLabel = platform;
    }

    async ensureReady(): Promise<void> {
        void vscode.window.showWarningMessage(
            `Voice recording is not supported on ${this.platformLabel}. Linux is currently the only supported platform.`
        );
        throw new Error(`Voice recording is not supported on ${this.platformLabel}`);
    }

    spawnWavToFile(_outputFile: string, _deviceId: string | null): cp.ChildProcess {
        throw new Error(`Voice recording is not supported on ${this.platformLabel}`);
    }

    spawnPcmStream(_deviceId: string | null): cp.ChildProcess {
        throw new Error(`Voice recording is not supported on ${this.platformLabel}`);
    }

    async listInputDevices(): Promise<AudioInputDevice[]> {
        return [];
    }

    async isSourceMuted(_deviceId: string | null): Promise<boolean | null> {
        return null;
    }
}

export function createRecorderBackend(_context: vscode.ExtensionContext): RecorderBackend {
    if (process.platform === 'linux') {
        return new LinuxPulseBackend();
    }

    const platformNames: Record<string, string> = {
        win32: 'Windows',
        darwin: 'macOS',
    };
    const platformLabel = platformNames[process.platform] ?? process.platform;
    return new UnsupportedPlatformBackend(platformLabel);
}
