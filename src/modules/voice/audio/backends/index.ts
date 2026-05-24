import * as vscode from 'vscode';

import { LinuxPulseBackend } from './linux-pulse-backend';
import { RecorderBackend } from './recorder-backend';

export { RecorderBackend, AudioInputDevice } from './recorder-backend';

export function createRecorderBackend(_context: vscode.ExtensionContext): RecorderBackend {
    switch (process.platform) {
        case 'linux':
            return new LinuxPulseBackend();
        case 'win32':
            throw new Error('Windows recorder backend is not implemented yet');
        case 'darwin':
            throw new Error('macOS recorder backend is not implemented yet');
        default:
            throw new Error(`Unsupported platform for voice recording: ${process.platform}`);
    }
}
