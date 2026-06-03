import * as vscode from 'vscode';
import * as crypto from 'crypto';

import { CommandDeps } from './types';
import { VoiceRecord } from '../webview/voice-log/types';
import { StreamingSession } from '../server/api-client';
import { DraftMode, DraftRecord, LogStore } from '../webview/voice-log/log-store';
import { buildInitialPrompt, loadVocabularyFromFile } from '../webview/voice-log/vocabulary-store';
import { encodePcmToWav } from '../audio/wav-encoder';
import { VOICE_CONFIG_SECTION, VOICE_DEFAULTS } from '../constants';
import { voiceLogDir, vocabularyFile, ensureDir } from '../../../shared/project-layout';

type StreamingModeValue = 'off' | 'on' | 'adaptive';

interface StreamingModeOption {
    value: StreamingModeValue;
    label: string;
    description: string;
    detail: string;
}

const STREAMING_MODE_OPTIONS: StreamingModeOption[] = [
    {
        value: 'off',
        label: 'Off (classic)',
        description: 'Record, stop, then transcribe in one shot',
        detail: 'Best accuracy on short messages. No GPU pressure during recording.',
    },
    {
        value: 'adaptive',
        label: 'Adaptive',
        description: 'Classic on short messages, live on long ones',
        detail: 'Switches to live transcription once recording exceeds the threshold (default 30s). Requires a GPU for the live phase.',
    },
    {
        value: 'on',
        label: 'On (always live)',
        description: 'Live transcription from the first second',
        detail: 'Best with a GPU. On CPU it lags behind speech on medium+ models.',
    },
];

export interface TranscribingState {
    readonly isActive: boolean;
    readonly onChanged: vscode.Event<boolean>;
}

export function registerRecordingCommands(deps: CommandDeps): TranscribingState {
    const { extensionContext, server, recorder, apiClient, activeProject, logStoreFor, extensionLog } = deps;

    let streamingSession: StreamingSession | null = null;
    let streamingStartMs: number = 0;
    let streamingDraftId: string = '';
    let streamingFinalText: string = '';
    let streamingLanguage: string = '';
    let streamingFinalizing: boolean = false;

    let adaptiveActive: boolean = false;
    let adaptiveBuffer: Buffer[] = [];
    let adaptiveBufferBytes: number = 0;
    let adaptiveTimer: NodeJS.Timeout | null = null;
    let adaptiveUpgradePromise: Promise<void> | null = null;
    let adaptiveInitialPrompt: string | null = null;
    let adaptiveIntervalSec: number = 2;
    let adaptiveHeadText: string = '';

    // Max PCM bytes held in adaptiveBuffer before forcing an upgrade (≈90s @ 16kHz/16bit/mono).
    const ADAPTIVE_BUFFER_BYTE_LIMIT = 3 * 1024 * 1024;

    // Snapshotted at recording start - writes always go to origin folder.
    let recordingLogStore: LogStore | null = null;
    // Vocabulary snapshotted at start so stopRecording uses the project that was
    // active when the recording began, not the one active when stop is pressed.
    let recordingVocabularySnapshot: string[] | null = null;

    let isTranscribing: boolean = false;
    const transcribingChangedEmitter = new vscode.EventEmitter<boolean>();
    extensionContext.subscriptions.push(transcribingChangedEmitter);

    // L4: when the recorder crashes into idle (async spawn error) the draft must
    // be cleared so it doesn't hang in the log panel indefinitely.
    extensionContext.subscriptions.push(
        recorder.onStateChanged(state => {
            if (state === 'idle') {
                clearDraft();
            }
        }),
    );

    function setTranscribing(value: boolean): void {
        if (isTranscribing === value) {
            return;
        }
        isTranscribing = value;
        vscode.commands.executeCommand('setContext', 'sonara.voice.isTranscribing', value);
        transcribingChangedEmitter.fire(value);
    }

    function currentDurationSec(): number {
        return (Date.now() - streamingStartMs) / 1000;
    }

    function clearDraft(): void {
        recordingLogStore?.setDraft(null);
    }

    function publishDraft(mode: DraftMode, confirmed: string, pending: string): void {
        if (!recordingLogStore) {
            return;
        }
        const draft: DraftRecord = {
            id: streamingDraftId,
            mode,
            confirmedText: confirmed,
            pendingText: pending,
            startedAt: new Date(streamingStartMs).toISOString(),
            durationSec: currentDurationSec(),
        };
        recordingLogStore.setDraft(draft);
    }

    function publishTranscribingDraft(durationSec: number, confirmed: string): void {
        if (!streamingDraftId || !streamingStartMs || !recordingLogStore) {
            return;
        }
        const draft: DraftRecord = {
            id: streamingDraftId,
            mode: 'transcribing',
            confirmedText: confirmed,
            pendingText: '',
            startedAt: new Date(streamingStartMs).toISOString(),
            durationSec,
        };
        recordingLogStore.setDraft(draft);
    }

    function joinHeadAndTail(head: string, tail: string): string {
        if (!head) {
            return tail;
        }
        if (!tail) {
            return head;
        }
        return head.replace(/\s+$/, '') + ' ' + tail.replace(/^\s+/, '');
    }

    function attachStreamingPartials(session: StreamingSession, headText: string = ''): void {
        let partialCount = 0;
        session.onPartial(partial => {
            partialCount++;
            if (partialCount <= 3 || partialCount % 5 === 0) {
                extensionLog.appendLine(
                    `[Streaming] partial #${partialCount}: confirmed="${partial.confirmedText.slice(-60)}", ` +
                    `pending="${partial.pendingText.slice(-60)}"`
                );
            }
            const combinedConfirmed = joinHeadAndTail(headText, partial.confirmedText);
            streamingFinalText = combinedConfirmed;
            if (streamingFinalizing) {
                return;
            }
            publishDraft('live', combinedConfirmed, partial.pendingText);
        });
    }

    function snapshotRecordingStore(): LogStore | null {
        const folder = activeProject.get();
        if (!folder) {
            return null;
        }
        const dir = voiceLogDir(folder);
        ensureDir(dir);
        return logStoreFor(folder);
    }

    function loadRecordingVocabulary(): string[] {
        const folder = activeProject.get();
        if (!folder) {
            return [];
        }
        const dir = voiceLogDir(folder);
        ensureDir(dir);
        return loadVocabularyFromFile(vocabularyFile(folder));
    }

    async function startStreamingFlow(): Promise<void> {
        const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);
        const language = config.get<string>('language', VOICE_DEFAULTS.language);
        const interval = config.get<number>('streamingIntervalSec', 2);

        recordingLogStore = snapshotRecordingStore();

        const vocabulary = loadRecordingVocabulary();
        recordingVocabularySnapshot = vocabulary;
        const initialPrompt = buildInitialPrompt(vocabulary);
        if (initialPrompt) {
            extensionLog.appendLine(`[Streaming] vocabulary terms: ${vocabulary.length}`);
        }

        extensionLog.appendLine(`[Streaming] starting, language=${language}, interval=${interval}s`);

        streamingLanguage = language;
        streamingFinalText = '';
        streamingDraftId = crypto.randomUUID();
        streamingStartMs = Date.now();
        streamingFinalizing = false;

        try {
            streamingSession = await apiClient.openTranscribeStream(
                language === 'auto' ? null : language,
                interval,
                initialPrompt,
            );
            extensionLog.appendLine('[Streaming] WebSocket opened');
        } catch (err) {
            extensionLog.appendLine(`[Streaming] WebSocket open failed: ${err}`);
            streamingSession = null;
            throw err;
        }

        attachStreamingPartials(streamingSession);

        publishDraft('live', '', '');
        extensionLog.appendLine(`[Streaming] initial draft published (id=${streamingDraftId})`);

        let chunkCount = 0;
        try {
            await recorder.startStreaming(chunk => {
                chunkCount++;
                if (chunkCount === 1 || chunkCount % 20 === 0) {
                    extensionLog.appendLine(`[Streaming] audio chunk #${chunkCount}, ${chunk.length} bytes`);
                }
                streamingSession?.sendAudio(chunk);
            });
        } catch (err) {
            extensionLog.appendLine(`[Streaming] recorder.startStreaming failed: ${err}`);
            streamingSession?.cancel();
            streamingSession = null;
            clearDraft();
            throw err;
        }
        extensionLog.appendLine('[Streaming] recorder started, piping PCM to WS');
    }

    async function startAdaptiveFlow(): Promise<void> {
        const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);
        const language = config.get<string>('language', VOICE_DEFAULTS.language);
        const thresholdSec = config.get<number>('adaptiveStreamingThresholdSec', 30);
        adaptiveIntervalSec = config.get<number>('streamingIntervalSec', 2);

        recordingLogStore = snapshotRecordingStore();

        const vocabulary = loadRecordingVocabulary();
        recordingVocabularySnapshot = vocabulary;
        adaptiveInitialPrompt = buildInitialPrompt(vocabulary);
        if (adaptiveInitialPrompt) {
            extensionLog.appendLine(`[Adaptive] vocabulary terms: ${vocabulary.length}`);
        }

        extensionLog.appendLine(`[Adaptive] starting, language=${language}, threshold=${thresholdSec}s`);

        streamingLanguage = language;
        streamingFinalText = '';
        streamingDraftId = crypto.randomUUID();
        streamingStartMs = Date.now();
        streamingFinalizing = false;
        adaptiveActive = true;
        adaptiveBuffer = [];
        adaptiveBufferBytes = 0;
        adaptiveUpgradePromise = null;
        adaptiveHeadText = '';

        publishDraft('recording', '', '');
        extensionLog.appendLine(`[Adaptive] initial recording draft published (id=${streamingDraftId})`);

        let chunkCount = 0;
        try {
            await recorder.startStreaming(chunk => {
                chunkCount++;
                if (chunkCount === 1 || chunkCount % 50 === 0) {
                    extensionLog.appendLine(`[Adaptive] audio chunk #${chunkCount}, ${chunk.length} bytes, ws=${streamingSession ? 'open' : 'buffer'}`);
                }
                if (streamingSession) {
                    streamingSession.sendAudio(chunk);
                } else {
                    adaptiveBuffer.push(chunk);
                    adaptiveBufferBytes += chunk.length;
                    if (adaptiveBufferBytes >= ADAPTIVE_BUFFER_BYTE_LIMIT && !adaptiveUpgradePromise) {
                        extensionLog.appendLine(`[Adaptive] buffer limit reached (${adaptiveBufferBytes} bytes), forcing upgrade`);
                        clearAdaptiveTimer();
                        adaptiveUpgradePromise = upgradeAdaptiveToStreaming().catch(upgradeErr => {
                            extensionLog.appendLine(`[Adaptive] forced upgrade failed: ${upgradeErr}`);
                        });
                    }
                }
            });
        } catch (err) {
            extensionLog.appendLine(`[Adaptive] recorder.startStreaming failed: ${err}`);
            adaptiveActive = false;
            adaptiveBuffer = [];
            adaptiveBufferBytes = 0;
            clearDraft();
            throw err;
        }

        adaptiveTimer = setTimeout(() => {
            adaptiveTimer = null;
            adaptiveUpgradePromise = upgradeAdaptiveToStreaming().catch(err => {
                extensionLog.appendLine(`[Adaptive] upgrade failed: ${err}`);
            });
        }, thresholdSec * 1000);
    }

    async function upgradeAdaptiveToStreaming(): Promise<void> {
        if (!adaptiveActive || streamingSession) {
            return;
        }

        const headChunks = adaptiveBuffer;
        adaptiveBuffer = [];
        adaptiveBufferBytes = 0;
        extensionLog.appendLine(`[Adaptive] threshold reached, transcribing buffered head (${headChunks.length} chunks)`);

        let headText = '';
        if (headChunks.length > 0) {
            const wavBuffer = encodePcmToWav(headChunks);
            const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);
            try {
                const headResult = await apiClient.transcribe(
                    wavBuffer,
                    streamingLanguage,
                    config.get<boolean>('vadFilter', VOICE_DEFAULTS.vadFilter),
                    adaptiveInitialPrompt,
                );
                headText = headResult.text.trim();
                extensionLog.appendLine(`[Adaptive] head transcribed, length=${headText.length}`);
            } catch (err) {
                extensionLog.appendLine(`[Adaptive] head transcribe failed, will fall back to streaming-only: ${err}`);
            }
        }

        if (!adaptiveActive) {
            extensionLog.appendLine('[Adaptive] aborted before WS open (adaptive flow ended during head transcribe)');
            adaptiveHeadText = headText;
            return;
        }

        adaptiveHeadText = headText;
        const headPromptTail = headText.slice(-200);
        const wsInitialPrompt = headPromptTail
            ? (adaptiveInitialPrompt ? `${adaptiveInitialPrompt} ${headPromptTail}` : headPromptTail)
            : adaptiveInitialPrompt;

        const session = await apiClient.openTranscribeStream(
            streamingLanguage === 'auto' ? null : streamingLanguage,
            adaptiveIntervalSec,
            wsInitialPrompt,
        );

        if (!adaptiveActive) {
            extensionLog.appendLine('[Adaptive] aborted after WS open (adaptive flow ended during openTranscribeStream)');
            session.cancel();
            return;
        }

        extensionLog.appendLine('[Adaptive] WebSocket opened');

        attachStreamingPartials(session, headText);

        const lateChunks = adaptiveBuffer;
        adaptiveBuffer = [];
        adaptiveBufferBytes = 0;
        for (const chunk of lateChunks) {
            session.sendAudio(chunk);
        }
        if (lateChunks.length > 0) {
            extensionLog.appendLine(`[Adaptive] flushed ${lateChunks.length} late chunks (recorded during head transcribe) to WS`);
        }

        streamingSession = session;
        streamingFinalText = headText;
        publishDraft('live', headText, '');
    }

    async function finalizeAdaptiveAsClassic(): Promise<void> {
        // headText is non-empty when upgrade was attempted but failed after the
        // head had already been transcribed (buffer was drained for transcription
        // before openTranscribeStream; the remaining tail is in adaptiveBuffer).
        const headText = adaptiveHeadText;
        const hasHead = headText.length > 0;
        if (hasHead) {
            extensionLog.appendLine(`[Adaptive] finalize as classic with pre-transcribed head (${headText.length} chars), tail chunks=${adaptiveBuffer.length}`);
        } else {
            extensionLog.appendLine('[Adaptive] finalize as classic (short message)');
        }

        let stopResult: { durationSec: number };
        try {
            stopResult = await recorder.stopStreaming();
            extensionLog.appendLine(`[Adaptive] recorder stopped, duration=${stopResult.durationSec.toFixed(2)}s`);
        } catch (err) {
            extensionLog.appendLine(`[Adaptive] recorder stopStreaming error: ${err}`);
            clearDraft();
            throw err;
        }

        const bufferedChunks = adaptiveBuffer;
        adaptiveBuffer = [];
        adaptiveBufferBytes = 0;

        // If we have only a pre-transcribed head and no tail audio, save it directly.
        if (hasHead && bufferedChunks.length === 0) {
            clearDraft();
            const trimmed = headText.trim();
            if (!trimmed) {
                return;
            }
            const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);
            const record: VoiceRecord = {
                id: streamingDraftId,
                timestamp: new Date(streamingStartMs).toISOString(),
                text: trimmed,
                language: streamingLanguage,
                duration_sec: stopResult.durationSec,
                model: config.get<string>('model', VOICE_DEFAULTS.model),
                tags: [],
                copied: false,
            };
            await recordingLogStore?.add(record);
            const showNotification = vscode.workspace
                .getConfiguration('sonara.voice.log')
                .get<boolean>('showNotificationOnTranscribe', true);
            if (showNotification) {
                const previewLimit = 50;
                const preview = trimmed.slice(0, previewLimit) + (trimmed.length > previewLimit ? '...' : '');
                vscode.window.showInformationMessage(`Transcribed: "${preview}"`);
            }
            return;
        }

        if (!hasHead && (stopResult.durationSec < 0.3 || bufferedChunks.length === 0)) {
            clearDraft();
            return;
        }

        publishTranscribingDraft(stopResult.durationSec, hasHead ? headText : '');

        const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);

        let tailText = '';
        if (bufferedChunks.length > 0) {
            const wavBuffer = encodePcmToWav(bufferedChunks);
            // When a head was already transcribed, use its tail as prompt for the tail segment.
            const tailPrompt = hasHead
                ? (headText.slice(-200) || adaptiveInitialPrompt)
                : adaptiveInitialPrompt;

            setTranscribing(true);
            try {
                const transcribeResult = await apiClient.transcribe(
                    wavBuffer,
                    config.get<string>('language', VOICE_DEFAULTS.language),
                    config.get<boolean>('vadFilter', VOICE_DEFAULTS.vadFilter),
                    tailPrompt,
                );
                tailText = transcribeResult.text;
            } catch (err) {
                clearDraft();
                vscode.window.showErrorMessage(`Transcription failed: ${err}`);
                return;
            } finally {
                setTranscribing(false);
            }
        }

        clearDraft();

        const combinedText = hasHead ? joinHeadAndTail(headText, tailText) : tailText;

        if (!combinedText.trim()) {
            vscode.window.showWarningMessage(
                'Recorded only silence. Check that your microphone is on, not muted, and selected as the active input.'
            );
            return;
        }

        const record: VoiceRecord = {
            id: streamingDraftId,
            timestamp: new Date(streamingStartMs).toISOString(),
            text: combinedText,
            language: streamingLanguage,
            duration_sec: stopResult.durationSec,
            model: config.get<string>('model', VOICE_DEFAULTS.model),
            tags: [],
            copied: false,
        };

        await recordingLogStore?.add(record);

        const showNotification = vscode.workspace
            .getConfiguration('sonara.voice.log')
            .get<boolean>('showNotificationOnTranscribe', true);
        if (showNotification) {
            const previewLimit = 50;
            const preview = combinedText.slice(0, previewLimit) +
                (combinedText.length > previewLimit ? '...' : '');
            vscode.window.showInformationMessage(`Transcribed: "${preview}"`);
        }
    }

    async function finalizeStreamingFlow(headText: string = ''): Promise<void> {
        const session = streamingSession;
        if (!session) {
            return;
        }
        extensionLog.appendLine('[Streaming] finalize requested');

        let stopResult: { durationSec: number };
        try {
            stopResult = await recorder.stopStreaming();
            extensionLog.appendLine(`[Streaming] recorder stopped, duration=${stopResult.durationSec.toFixed(2)}s`);
        } catch (err) {
            extensionLog.appendLine(`[Streaming] recorder stopStreaming error: ${err}`);
            session.cancel();
            streamingSession = null;
            clearDraft();
            throw err;
        }

        // If cancelStreamingFlow ran while stopStreaming was awaited it already
        // cancelled the session and nulled streamingSession - abort without saving.
        if (streamingSession === null) {
            extensionLog.appendLine('[Streaming] finalize aborted: session was cancelled during stopStreaming');
            clearDraft();
            return;
        }

        streamingFinalizing = true;
        publishTranscribingDraft(stopResult.durationSec, streamingFinalText);

        setTranscribing(true);
        let finalText = streamingFinalText;
        let finalizeErrored = false;
        try {
            const result = await session.finalize();
            const tailText = result.text || '';
            finalText = headText
                ? joinHeadAndTail(headText, tailText)
                : (tailText || finalText);
            extensionLog.appendLine(`[Streaming] final text length=${finalText.length}`);
        } catch (err) {
            extensionLog.appendLine(`[Streaming] finalize error: ${err}`);
            finalizeErrored = true;
            // finalText retains the last known streamingFinalText (partials accumulated so far)
        } finally {
            setTranscribing(false);
        }

        // Check again: cancelStreamingFlow may have run during session.finalize().
        if (streamingSession === null) {
            extensionLog.appendLine('[Streaming] finalize aborted: session was cancelled during finalize');
            clearDraft();
            return;
        }

        streamingSession = null;
        clearDraft();

        const trimmed = finalText.trim();
        if (stopResult.durationSec < 0.3 || !trimmed) {
            return;
        }

        if (finalizeErrored) {
            vscode.window.showWarningMessage(
                'Finalization failed - saving partial transcription captured so far.'
            );
        }

        const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);
        const record: VoiceRecord = {
            id: streamingDraftId,
            timestamp: new Date(streamingStartMs).toISOString(),
            text: trimmed,
            language: streamingLanguage,
            duration_sec: stopResult.durationSec,
            model: config.get<string>('model', VOICE_DEFAULTS.model),
            tags: [],
            copied: false,
        };

        await recordingLogStore?.add(record);

        const showNotification = vscode.workspace
            .getConfiguration('sonara.voice.log')
            .get<boolean>('showNotificationOnTranscribe', true);
        if (showNotification) {
            const previewLimit = 50;
            const preview = trimmed.slice(0, previewLimit) + (trimmed.length > previewLimit ? '...' : '');
            vscode.window.showInformationMessage(`Transcribed: "${preview}"`);
        }
    }

    async function finalizeAdaptiveFlow(): Promise<void> {
        clearAdaptiveTimer();

        if (adaptiveUpgradePromise) {
            await adaptiveUpgradePromise.catch(() => undefined);
        }
        adaptiveUpgradePromise = null;

        const wasUpgraded = streamingSession !== null;
        const headText = adaptiveHeadText;
        adaptiveActive = false;
        adaptiveHeadText = '';

        if (wasUpgraded) {
            await finalizeStreamingFlow(headText);
        } else {
            await finalizeAdaptiveAsClassic();
        }
    }

    function warnIfMicrophoneMuted(): void {
        recorder.isConfiguredSourceMuted().then(muted => {
            if (muted === true) {
                vscode.window.showWarningMessage(
                    'Microphone appears to be muted in the system. Check the mute button on your mic - the LED might be red.'
                );
            }
        }).catch(() => {
            // mute probe failed - silently skip, post-record silence check still covers this case
        });
    }

    function clearAdaptiveTimer(): void {
        if (adaptiveTimer) {
            clearTimeout(adaptiveTimer);
            adaptiveTimer = null;
        }
    }

    async function cancelStreamingFlow(): Promise<void> {
        clearAdaptiveTimer();
        adaptiveActive = false;
        adaptiveBuffer = [];
        adaptiveBufferBytes = 0;
        adaptiveUpgradePromise = null;
        adaptiveHeadText = '';
        streamingFinalizing = false;

        if (streamingSession) {
            streamingSession.cancel();
            streamingSession = null;
        }
        if (recorder.state === 'starting' || recorder.state === 'recording' || recorder.state === 'finishing') {
            try {
                await recorder.cancel();
            } catch {
                // already stopped
            }
        }
        clearDraft();
    }

    function getStreamingMode(): StreamingModeValue {
        const raw = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION).get<unknown>('streamingMode', 'off');
        if (raw === true) {
            return 'on';
        }
        if (raw === false) {
            return 'off';
        }
        if (raw === 'on' || raw === 'adaptive' || raw === 'off') {
            return raw;
        }
        return 'off';
    }

    extensionContext.subscriptions.push(
        vscode.commands.registerCommand('sonara.voice.toggleStreamingMode', async () => {
            const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);
            const current = getStreamingMode();

            const items: Array<vscode.QuickPickItem & { value: StreamingModeValue }> =
                STREAMING_MODE_OPTIONS.map(option => ({
                    label: option.value === current ? `$(check) ${option.label}` : `      ${option.label}`,
                    description: option.description,
                    detail: option.detail,
                    value: option.value,
                }));

            const picked = await vscode.window.showQuickPick(items, {
                title: 'Streaming Mode',
                placeHolder: `Current: ${STREAMING_MODE_OPTIONS.find(o => o.value === current)?.label ?? current}`,
                matchOnDescription: true,
                matchOnDetail: true,
            });

            if (!picked || picked.value === current) {
                return;
            }

            await config.update('streamingMode', picked.value, vscode.ConfigurationTarget.Global);
            const newLabel = STREAMING_MODE_OPTIONS.find(o => o.value === picked.value)?.label ?? picked.value;
            vscode.window.showInformationMessage(`Streaming mode: ${newLabel}`);
        }),

        vscode.commands.registerCommand('sonara.voice.toggleRecording', async () => {
            if (recorder.state === 'recording') {
                await vscode.commands.executeCommand('sonara.voice.stopRecording');
                return;
            }
            if (recorder.state === 'finishing' || recorder.state === 'processing') {
                // Busy wrapping up the previous recording - ignore silently.
                return;
            }
            if (isTranscribing) {
                vscode.window.showInformationMessage(
                    'Wait, transcribing the previous recording...',
                );
                return;
            }
            if (recorder.state === 'idle') {
                await vscode.commands.executeCommand('sonara.voice.startRecording');
            }
        }),

        vscode.commands.registerCommand('sonara.voice.cancelRecording', async () => {
            await vscode.commands.executeCommand('setContext', 'sonara.voice.isRecording', false);
            if (recorder.state !== 'starting' && recorder.state !== 'recording' && recorder.state !== 'finishing') {
                return;
            }
            if (streamingSession || adaptiveActive) {
                await cancelStreamingFlow();
            } else {
                await recorder.cancel();
            }
        }),

        vscode.commands.registerCommand('sonara.voice.startRecording', async () => {
            if (server.status !== 'ready') {
                vscode.window.showWarningMessage('Voice server is not ready yet.');
                return;
            }
            if (isTranscribing) {
                vscode.window.showInformationMessage(
                    'Wait, transcribing the previous recording...',
                );
                return;
            }
            if (recorder.state !== 'idle') {
                // 'starting' also blocks re-entry: the recorder is already initialising
                return;
            }
            if (!activeProject.get()) {
                vscode.window.showInformationMessage('Open a folder to use voice features.');
                return;
            }
            await vscode.commands.executeCommand('setContext', 'sonara.voice.isRecording', true);
            try {
                const mode = getStreamingMode();
                if (mode === 'on') {
                    await startStreamingFlow();
                } else if (mode === 'adaptive') {
                    await startAdaptiveFlow();
                } else {
                    recordingLogStore = snapshotRecordingStore();
                    const classicVocabulary = loadRecordingVocabulary();
                    recordingVocabularySnapshot = classicVocabulary;
                    streamingStartMs = Date.now();
                    streamingDraftId = crypto.randomUUID();
                    publishDraft('recording', '', '');
                    await recorder.start();
                }
                warnIfMicrophoneMuted();
            } catch (err) {
                await vscode.commands.executeCommand('setContext', 'sonara.voice.isRecording', false);
                streamingSession?.cancel();
                streamingSession = null;
                clearAdaptiveTimer();
                adaptiveActive = false;
                adaptiveBuffer = [];
                clearDraft();
                vscode.window.showErrorMessage(`Failed to start recording: ${err}`);
            }
        }),

        vscode.commands.registerCommand('sonara.voice.stopRecording', async () => {
            await vscode.commands.executeCommand('setContext', 'sonara.voice.isRecording', false);
            if (recorder.state !== 'recording') {
                return;
            }

            if (adaptiveActive) {
                try {
                    await finalizeAdaptiveFlow();
                } catch (err) {
                    vscode.window.showErrorMessage(`Recording failed: ${err}`);
                }
                return;
            }

            if (streamingSession) {
                try {
                    await finalizeStreamingFlow();
                } catch (err) {
                    vscode.window.showErrorMessage(`Recording failed: ${err}`);
                }
                return;
            }

            let result;
            try {
                result = await recorder.stop();
            } catch (err) {
                clearDraft();
                vscode.window.showErrorMessage(`Recording failed: ${err}`);
                return;
            }

            if (!result || result.durationSec < 0.3) {
                clearDraft();
                return;
            }

            publishTranscribingDraft(result.durationSec, '');

            const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);
            // Use the vocabulary snapshotted at recording start so the correct
            // project's terms are used even if the active project changed.
            const vocabulary = recordingVocabularySnapshot ?? loadRecordingVocabulary();
            const initialPrompt = buildInitialPrompt(vocabulary);

            setTranscribing(true);
            let transcribeResult;
            try {
                transcribeResult = await apiClient.transcribe(
                    result.wavBuffer,
                    config.get<string>('language', VOICE_DEFAULTS.language),
                    config.get<boolean>('vadFilter', VOICE_DEFAULTS.vadFilter),
                    initialPrompt,
                );
            } catch (err) {
                clearDraft();
                vscode.window.showErrorMessage(`Transcription failed: ${err}`);
                return;
            } finally {
                setTranscribing(false);
            }

            clearDraft();

            if (!transcribeResult.text.trim()) {
                vscode.window.showWarningMessage(
                    'Recorded only silence. Check that your microphone is on, not muted, and selected as the active input.'
                );
                return;
            }

            const record: VoiceRecord = {
                id: streamingDraftId || crypto.randomUUID(),
                timestamp: new Date(streamingStartMs || Date.now()).toISOString(),
                text: transcribeResult.text,
                language: transcribeResult.language,
                duration_sec: transcribeResult.durationSec,
                model: config.get<string>('model', VOICE_DEFAULTS.model),
                tags: [],
                copied: false,
            };

            await recordingLogStore?.add(record);

            const showNotification = vscode.workspace
                .getConfiguration('sonara.voice.log')
                .get<boolean>('showNotificationOnTranscribe', true);

            if (showNotification) {
                const previewLimit = 50;
                const preview = transcribeResult.text.slice(0, previewLimit) +
                    (transcribeResult.text.length > previewLimit ? '...' : '');
                vscode.window.showInformationMessage(`Transcribed: "${preview}"`);
            }
        }),
    );

    return {
        get isActive(): boolean {
            return isTranscribing;
        },
        onChanged: transcribingChangedEmitter.event,
    };
}
