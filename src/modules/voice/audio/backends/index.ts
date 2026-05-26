import * as vscode from 'vscode';

import { FfmpegInstaller } from './ffmpeg-installer';
import { LinuxPulseBackend } from './linux-pulse-backend';
import { RecorderBackend } from './recorder-backend';
import { WindowsFfmpegBackend } from './windows-ffmpeg-backend';

export { RecorderBackend, AudioInputDevice } from './recorder-backend';
export { FfmpegInstaller } from './ffmpeg-installer';

export interface RecorderBackendBundle {
    backend: RecorderBackend;
    /** Present only on platforms that use a self-installed ffmpeg (Windows). */
    ffmpegInstaller?: FfmpegInstaller;
}

export function createRecorderBackend(context: vscode.ExtensionContext): RecorderBackendBundle {
    switch (process.platform) {
        case 'linux':
            return { backend: new LinuxPulseBackend() };
        case 'win32': {
            const installer = new FfmpegInstaller(context);
            return { backend: new WindowsFfmpegBackend(installer), ffmpegInstaller: installer };
        }
        case 'darwin':
            throw new Error('macOS recorder backend is not implemented yet');
        default:
            throw new Error(`Unsupported platform for voice recording: ${process.platform}`);
    }
}
