import * as vscode from 'vscode';

import { ApiClient, TranscribeResult } from '../server/api-client';
import {
    MODEL_DESCRIPTIONS,
    VOICE_CONFIG_SECTION,
    VOICE_DEFAULTS,
    WHISPER_MODELS,
    type WhisperModel,
} from '../constants';

export interface CudaOomRecoveryServer {
    runWithModelLoadingProgress<T>(title: string, operation: () => Promise<T>): Promise<T>;
}

export interface CudaOomRecoveryArgs {
    readonly apiClient: ApiClient;
    readonly wavBuffer: Buffer;
    readonly currentModel: WhisperModel;
    readonly language: string;
    readonly vadFilter: boolean;
    readonly initialPrompt: string | null;
    readonly server: CudaOomRecoveryServer;
    readonly extensionLog: vscode.OutputChannel;
}

type RecoveryChoice =
    | { kind: 'cpu' }
    | { kind: 'smaller'; model: WhisperModel };

interface RecoveryPickItem extends vscode.QuickPickItem {
    value: RecoveryChoice | null;
}

function smallerModels(currentModel: WhisperModel): WhisperModel[] {
    const idx = WHISPER_MODELS.indexOf(currentModel);
    if (idx <= 0) {
        return [];
    }
    return WHISPER_MODELS.slice(0, idx) as WhisperModel[];
}

/**
 * Show the recovery picker. Returns the chosen recovery action, or null if the user cancelled.
 */
async function pickRecoveryChoice(currentModel: WhisperModel): Promise<RecoveryChoice | null> {
    const items: RecoveryPickItem[] = [];

    items.push({
        label: '$(refresh) Retry on CPU (this recording only)',
        description: 'Slower, but works. Settings unchanged.',
        detail: `Uses the same model "${currentModel}" loaded on CPU. The main GPU model stays loaded.`,
        value: { kind: 'cpu' },
    });

    for (const smaller of smallerModels(currentModel).slice().reverse()) {
        const desc = MODEL_DESCRIPTIONS[smaller];
        items.push({
            label: `$(arrow-down) ${smaller}`,
            description: `${desc.size} • temporary, settings unchanged`,
            detail: desc.detail,
            value: { kind: 'smaller', model: smaller },
        });
    }

    const picked = await vscode.window.showQuickPick(items, {
        title: 'GPU out of memory',
        placeHolder: `Current model "${currentModel}" does not fit in GPU memory. Choose how to recover this recording:`,
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true,
    });

    if (!picked || !picked.value) {
        return null;
    }
    return picked.value;
}

/**
 * Run the OOM-recovery flow for a single recording.
 * Returns the transcribe result, or null if the user cancelled the picker.
 * If the recovery attempt itself fails, the error is propagated to the caller.
 */
export async function recoverFromCudaOom(args: CudaOomRecoveryArgs): Promise<TranscribeResult | null> {
    const { apiClient, wavBuffer, currentModel, language, vadFilter, initialPrompt, server, extensionLog } = args;

    const choice = await pickRecoveryChoice(currentModel);
    if (!choice) {
        extensionLog.appendLine('[CudaOomRecovery] user cancelled');
        return null;
    }

    if (choice.kind === 'cpu') {
        extensionLog.appendLine('[CudaOomRecovery] user picked: cpu');
        return server.runWithModelLoadingProgress(
            'Transcribing on CPU (one-time fallback)...',
            () => apiClient.transcribe(wavBuffer, language, vadFilter, initialPrompt, 'cpu'),
        );
    }

    const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);
    const device = config.get<string>('device', VOICE_DEFAULTS.device);
    const computeType = config.get<string>('computeType', VOICE_DEFAULTS.computeType);
    const beamSize = config.get<number>('beamSize', VOICE_DEFAULTS.beamSize);

    const targetModel = choice.model;
    extensionLog.appendLine(`[CudaOomRecovery] user picked: smaller model "${targetModel}"`);

    let result: TranscribeResult | null = null;
    let transcribeError: unknown = null;

    try {
        await server.runWithModelLoadingProgress(
            `Loading smaller model "${targetModel}"...`,
            () => apiClient.reloadModel(targetModel, device, computeType, beamSize),
        );
        extensionLog.appendLine(`[CudaOomRecovery] reloaded to ${targetModel}`);

        try {
            result = await server.runWithModelLoadingProgress(
                `Transcribing with "${targetModel}"...`,
                () => apiClient.transcribe(wavBuffer, language, vadFilter, initialPrompt, null),
            );
        } catch (err) {
            transcribeError = err;
            extensionLog.appendLine(`[CudaOomRecovery] transcribe with ${targetModel} failed: ${err}`);
        }
    } finally {
        try {
            await server.runWithModelLoadingProgress(
                `Restoring model "${currentModel}"...`,
                () => apiClient.reloadModel(currentModel, device, computeType, beamSize),
            );
            extensionLog.appendLine(`[CudaOomRecovery] reloaded back to ${currentModel}`);
        } catch (restoreErr) {
            extensionLog.appendLine(
                `[CudaOomRecovery] FAILED to restore model "${currentModel}": ${restoreErr}`,
            );
            vscode.window.showErrorMessage(
                `Failed to restore model "${currentModel}" after OOM recovery: ${restoreErr}. ` +
                'Run "Sonara: Change Whisper Model" to reload manually.',
            );
        }
    }

    if (transcribeError !== null) {
        throw transcribeError;
    }
    return result;
}
