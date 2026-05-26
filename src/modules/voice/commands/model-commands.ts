import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { CommandDeps } from './types';
import {
    WHISPER_MODELS,
    GLOBAL_STATE_KEYS,
    MODEL_DESCRIPTIONS,
    VOICE_CONFIG_SECTION,
    VOICE_DEFAULTS,
    type WhisperModel,
    type SetupMode,
    type DeviceOption,
} from '../constants';
import { buildLanguageQuickPickItems } from '../language-picker';
import { ApiClient } from '../server/api-client';
import { modelsDir as serverModelsDir } from '../../../shared/server-runtime';

function reloadModelFromConfig(
    apiClient: ApiClient,
    config: vscode.WorkspaceConfiguration,
    overrides: { model?: string; device?: string } = {},
): Promise<void> {
    return apiClient.reloadModel(
        overrides.model ?? config.get<string>('model', VOICE_DEFAULTS.model),
        overrides.device ?? config.get<string>('device', VOICE_DEFAULTS.device),
        config.get<string>('computeType', VOICE_DEFAULTS.computeType),
        config.get<number>('beamSize', VOICE_DEFAULTS.beamSize),
    );
}

function isModelDownloaded(modelsDir: string, model: WhisperModel): boolean {
    const modelDir = path.join(modelsDir, `models--Systran--faster-whisper-${model}`);
    // HuggingFace writes refs/main only after every blob is fully downloaded.
    const refsMain = path.join(modelDir, 'refs', 'main');
    if (!fs.existsSync(refsMain)) {
        return false;
    }
    const blobsDir = path.join(modelDir, 'blobs');
    if (fs.existsSync(blobsDir)) {
        const blobs = fs.readdirSync(blobsDir);
        if (blobs.some(f => f.endsWith('.incomplete') || f.endsWith('.tmp') || f.endsWith('.lock'))) {
            return false;
        }
    }
    return true;
}

export function registerModelCommands(deps: CommandDeps): void {
    const { extensionContext, server, apiClient } = deps;
    const modelsDir = serverModelsDir(extensionContext.globalStorageUri.fsPath);

    extensionContext.subscriptions.push(
        vscode.commands.registerCommand('sonara.voice.changeModel', async () => {
            const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);
            const currentModel = config.get<string>('model', VOICE_DEFAULTS.model);

            const items: vscode.QuickPickItem[] = WHISPER_MODELS.map(model => {
                const downloaded = isModelDownloaded(modelsDir, model);
                const marks: string[] = [MODEL_DESCRIPTIONS[model].size];
                if (model === currentModel) {
                    marks.push('(current)');
                }
                if (downloaded) {
                    marks.push('✓ downloaded');
                }
                return {
                    label: model,
                    description: marks.join('  '),
                    detail: MODEL_DESCRIPTIONS[model].detail,
                };
            });

            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select Whisper model',
                matchOnDetail: true,
            });
            if (!picked || picked.label === currentModel) {
                return;
            }

            if (server.status !== 'ready') {
                await config.update('model', picked.label, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(
                    `Model set to "${picked.label}". It will be loaded on the next server start.`,
                );
                return;
            }

            try {
                await server.runWithModelLoadingProgress(
                    `Loading model "${picked.label}"...`,
                    () => reloadModelFromConfig(apiClient, config, { model: picked.label }),
                );
                await config.update('model', picked.label, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Model changed to "${picked.label}".`);
            } catch (err) {
                vscode.window.showErrorMessage(
                    `Failed to load model "${picked.label}": ${err}. Previous model still active.`,
                );
            }
        }),

        vscode.commands.registerCommand('sonara.voice.changeLanguage', async () => {
            const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);
            const currentLanguage = config.get<string>('language', VOICE_DEFAULTS.language);

            const picked = await vscode.window.showQuickPick(
                buildLanguageQuickPickItems(currentLanguage, '(current)'),
                { placeHolder: 'Select transcription language' },
            );
            if (!picked || !picked.value) {
                return;
            }
            await config.update('language', picked.value, vscode.ConfigurationTarget.Global);
        }),

        vscode.commands.registerCommand('sonara.voice.changeDevice', async () => {
            const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);
            const currentDevice = config.get<string>('device', VOICE_DEFAULTS.device);
            const setupMode = extensionContext.globalState.get<SetupMode>(
                GLOBAL_STATE_KEYS.setupMode,
                'cpu',
            );

            const items: Array<vscode.QuickPickItem & { value: DeviceOption }> = [
                {
                    label: 'auto',
                    value: 'auto',
                    description: currentDevice === 'auto' ? '(current)' : '',
                    detail: 'CUDA if available, otherwise CPU',
                },
                {
                    label: 'cpu',
                    value: 'cpu',
                    description: currentDevice === 'cpu' ? '(current)' : '',
                    detail: 'Force CPU (slower, works everywhere)',
                },
            ];

            if (setupMode === 'gpu') {
                items.push(
                    {
                        label: 'cuda:0',
                        value: 'cuda:0',
                        description: currentDevice === 'cuda:0' ? '(current)' : '',
                        detail: 'First NVIDIA GPU',
                    },
                    {
                        label: 'cuda:1',
                        value: 'cuda:1',
                        description: currentDevice === 'cuda:1' ? '(current)' : '',
                        detail: 'Second NVIDIA GPU',
                    },
                );
            }

            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: setupMode === 'gpu'
                    ? 'Select compute device'
                    : 'Select compute device (GPU options disabled: CPU-only setup)',
                matchOnDetail: true,
            });

            if (!picked || picked.value === currentDevice) {
                return;
            }

            if (server.status !== 'ready') {
                await config.update('device', picked.value, vscode.ConfigurationTarget.Global);
                return;
            }

            try {
                await server.runWithModelLoadingProgress(
                    `Switching to "${picked.value}"...`,
                    () => reloadModelFromConfig(apiClient, config, { device: picked.value }),
                );
                await config.update('device', picked.value, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Device changed to "${picked.value}".`);
            } catch (err) {
                vscode.window.showErrorMessage(
                    `Failed to switch device: ${err}. Previous device still active.`,
                );
            }
        }),

        vscode.commands.registerCommand('sonara.voice.downloadModel', async () => {
            const items: vscode.QuickPickItem[] = WHISPER_MODELS.map(model => {
                const downloaded = isModelDownloaded(modelsDir, model);
                const marks = [MODEL_DESCRIPTIONS[model].size];
                if (downloaded) {
                    marks.push('✓ already downloaded');
                }
                return {
                    label: model,
                    description: marks.join('  '),
                    detail: MODEL_DESCRIPTIONS[model].detail,
                };
            });
            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select model to download',
                matchOnDetail: true,
            });
            if (!picked) {
                return;
            }
            if (server.status !== 'ready') {
                vscode.window.showWarningMessage('Voice server is not ready yet.');
                return;
            }

            const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);
            const currentModel = config.get<string>('model', VOICE_DEFAULTS.model);
            try {
                await server.runWithModelLoadingProgress(
                    `Downloading model "${picked.label}"...`,
                    () => reloadModelFromConfig(apiClient, config, { model: picked.label }),
                );
                if (currentModel !== picked.label) {
                    await server.runWithModelLoadingProgress(
                        `Restoring model "${currentModel}"...`,
                        () => reloadModelFromConfig(apiClient, config, { model: currentModel }),
                    );
                }
                vscode.window.showInformationMessage(`Model "${picked.label}" downloaded.`);
            } catch (err) {
                vscode.window.showErrorMessage(`Download failed: ${err}`);
            }
        }),
    );
}
