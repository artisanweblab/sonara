import * as vscode from 'vscode';

import { CommandDeps } from './types';
import { VOICE_CONFIG_SECTION } from '../constants';

interface AudioInputQuickPickItem extends vscode.QuickPickItem {
    deviceId: string | null;
}

export function registerAudioInputCommands(deps: CommandDeps): void {
    const { extensionContext, recorder } = deps;

    extensionContext.subscriptions.push(
        vscode.commands.registerCommand('sonara.voice.changeAudioInput', async () => {
            const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);
            const currentId = config.get<string | null>('audioInput', null);

            const devices = await recorder.listInputDevices();

            const items: AudioInputQuickPickItem[] = [];
            const isFollowSystemDefault = currentId === null;
            items.push({
                label: `${isFollowSystemDefault ? '$(check)' : '$(blank)'} System default`,
                description: isFollowSystemDefault ? '(current)' : '',
                detail: 'Follow the OS default - changes automatically if you switch system default.',
                deviceId: null,
            });

            for (const device of devices) {
                const isCurrent = device.id === currentId;
                const marks: string[] = [];
                if (device.isDefault) {
                    marks.push('system default');
                }
                if (isCurrent) {
                    marks.push('current');
                }
                items.push({
                    label: `${isCurrent ? '$(check)' : '$(blank)'} ${device.label}`,
                    description: marks.length > 0 ? `(${marks.join(', ')})` : '',
                    detail: device.id,
                    deviceId: device.id,
                });
            }

            if (devices.length === 0) {
                items.push({
                    label: '$(info) No additional devices detected',
                    description: '',
                    detail: 'Device enumeration unavailable on this system. System default still works.',
                    deviceId: null,
                });
            }

            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select audio input device for recording',
                matchOnDetail: true,
            });
            if (!picked) {
                return;
            }
            if (picked.deviceId === currentId) {
                return;
            }
            await config.update('audioInput', picked.deviceId, vscode.ConfigurationTarget.Global);
            const label = picked.deviceId ? picked.label : 'System default';

            const isRecordingActive = recorder.state !== 'idle';
            if (isRecordingActive) {
                vscode.window.showWarningMessage(
                    `Audio input will be set to "${label}" starting from the next recording.`
                );
            } else {
                vscode.window.showInformationMessage(`Audio input set to "${label}".`);
            }
        }),
    );
}
