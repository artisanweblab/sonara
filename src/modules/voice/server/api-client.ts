import WebSocket from 'ws';

export interface TranscribeResult {
    text: string;
    language: string;
    durationSec: number;
    processingTimeSec: number;
}

export interface HealthResult {
    status: string;
    model: string;
    device: string;
    uptimeSec: number;
}

export interface TranscribedSegment {
    start: number;
    end: number;
    text: string;
}

export interface FileTranscribeResult {
    segments: TranscribedSegment[];
    language: string;
    durationSec: number;
    processingTimeSec: number;
}

export interface FileTranscribeProgress {
    currentSec: number;
    totalSec: number;
}

export class TranscriptionCancelledError extends Error {
    constructor() {
        super('Transcription cancelled');
        this.name = 'TranscriptionCancelledError';
    }
}

export interface StreamingPartial {
    confirmedText: string;
    pendingText: string;
    durationSec: number;
}

export interface StreamingFinal {
    text: string;
    durationSec: number;
}

export interface StreamingSession {
    sendAudio(pcm: Buffer): void;
    onPartial(listener: (partial: StreamingPartial) => void): void;
    finalize(): Promise<StreamingFinal>;
    cancel(): void;
}

export class ApiClient {
    private baseUrl: string = '';
    private port: number = 0;
    private token: string = '';

    configure(port: number, token: string): void {
        this.baseUrl = `http://127.0.0.1:${port}`;
        this.port = port;
        this.token = token;
    }

    async transcribe(
        wavBuffer: Buffer,
        language: string = 'auto',
        vadFilter: boolean = true,
        initialPrompt: string | null = null,
    ): Promise<TranscribeResult> {
        const formData = new FormData();
        const arrayBuffer: ArrayBuffer = wavBuffer.buffer instanceof ArrayBuffer
            ? wavBuffer.buffer.slice(wavBuffer.byteOffset, wavBuffer.byteOffset + wavBuffer.byteLength) as ArrayBuffer
            : new Uint8Array(wavBuffer).buffer;
        const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
        formData.append('audio', blob, 'recording.wav');
        if (language !== 'auto') {
            formData.append('language', language);
        }
        formData.append('vad_filter', String(vadFilter));
        if (initialPrompt) {
            formData.append('initial_prompt', initialPrompt);
        }

        const response = await fetch(`${this.baseUrl}/transcribe`, {
            method: 'POST',
            headers: { 'X-Extension-Token': this.token },
            body: formData,
            signal: AbortSignal.timeout(60000),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`Transcribe failed: HTTP ${response.status} - ${text}`);
        }

        const body = await response.json() as {
            text: string;
            language: string;
            duration_sec: number;
            processing_time_sec: number;
        };

        return {
            text: body.text,
            language: body.language,
            durationSec: body.duration_sec,
            processingTimeSec: body.processing_time_sec,
        };
    }

    async transcribeFile(
        filePath: string,
        language: string | null,
        onProgress: (progress: FileTranscribeProgress) => void,
        initialPrompt: string | null = null,
        signal: AbortSignal | null = null,
    ): Promise<FileTranscribeResult> {
        const isAbortError = (err: unknown): boolean =>
            err instanceof Error && (err.name === 'AbortError' || (signal !== null && signal.aborted));

        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}/transcribe-file`, {
                method: 'POST',
                headers: {
                    'X-Extension-Token': this.token,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    path: filePath,
                    language: language ?? undefined,
                    initial_prompt: initialPrompt ?? undefined,
                }),
                signal: signal ?? undefined,
            });
        } catch (err) {
            if (isAbortError(err)) {
                throw new TranscriptionCancelledError();
            }
            throw err;
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`Transcribe-file failed: HTTP ${response.status} - ${text}`);
        }
        if (!response.body) {
            throw new Error('Transcribe-file: no response body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalResult: FileTranscribeResult | null = null;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) {
                        continue;
                    }
                    const msg = JSON.parse(trimmed) as
                        | { type: 'progress'; current_sec: number; total_sec: number }
                        | { type: 'result'; segments: TranscribedSegment[]; language: string; duration_sec: number; processing_time_sec: number }
                        | { type: 'error'; message: string };

                    if (msg.type === 'progress') {
                        onProgress({ currentSec: msg.current_sec, totalSec: msg.total_sec });
                    } else if (msg.type === 'result') {
                        finalResult = {
                            segments: msg.segments,
                            language: msg.language,
                            durationSec: msg.duration_sec,
                            processingTimeSec: msg.processing_time_sec,
                        };
                    } else if (msg.type === 'error') {
                        throw new Error(msg.message);
                    }
                }
            }
        } catch (err) {
            if (isAbortError(err)) {
                try {
                    await reader.cancel();
                } catch {
                    // reader already closed, ignore
                }
                throw new TranscriptionCancelledError();
            }
            throw err;
        }

        if (!finalResult) {
            throw new Error('Transcribe-file: stream ended without result');
        }
        return finalResult;
    }

    async health(): Promise<HealthResult> {
        const response = await fetch(`${this.baseUrl}/health`, {
            headers: { 'X-Extension-Token': this.token },
            signal: AbortSignal.timeout(3000),
        });

        if (!response.ok) {
            throw new Error(`Health check failed: HTTP ${response.status}`);
        }

        const body = await response.json() as {
            status: string;
            model: string;
            device: string;
            uptime_sec: number;
        };

        return {
            status: body.status,
            model: body.model,
            device: body.device,
            uptimeSec: body.uptime_sec,
        };
    }

    async openTranscribeStream(
        language: string | null,
        intervalSec: number = 2.0,
        initialPrompt: string | null = null,
    ): Promise<StreamingSession> {
        const url = new URL(`ws://127.0.0.1:${this.port}/transcribe-stream`);
        url.searchParams.set('token', this.token);
        url.searchParams.set('interval', String(intervalSec));
        if (language) {
            url.searchParams.set('language', language);
        }
        if (initialPrompt) {
            url.searchParams.set('initial_prompt', initialPrompt);
        }

        const ws = new WebSocket(url.toString());

        await new Promise<void>((resolve, reject) => {
            const onOpen = (): void => {
                ws.off('error', onError);
                resolve();
            };
            const onError = (err: Error): void => {
                ws.off('open', onOpen);
                reject(err);
            };
            ws.once('open', onOpen);
            ws.once('error', onError);
        });

        const partialListeners: Array<(p: StreamingPartial) => void> = [];
        let finalResolve: ((r: StreamingFinal) => void) | null = null;
        let finalReject: ((e: Error) => void) | null = null;

        ws.on('message', (raw: Buffer | string) => {
            const text = typeof raw === 'string' ? raw : raw.toString('utf8');
            let msg: {
                type: string;
                confirmed?: string;
                pending?: string;
                text?: string;
                duration_sec?: number;
                message?: string;
            };
            try {
                msg = JSON.parse(text);
            } catch {
                return;
            }
            if (msg.type === 'partial') {
                for (const listener of partialListeners) {
                    listener({
                        confirmedText: msg.confirmed ?? '',
                        pendingText: msg.pending ?? '',
                        durationSec: msg.duration_sec ?? 0,
                    });
                }
            } else if (msg.type === 'final') {
                finalResolve?.({ text: msg.text ?? '', durationSec: msg.duration_sec ?? 0 });
                finalResolve = null;
                finalReject = null;
            } else if (msg.type === 'error') {
                finalReject?.(new Error(msg.message ?? 'Streaming error'));
                finalResolve = null;
                finalReject = null;
            }
        });

        ws.on('error', (err: Error) => {
            finalReject?.(err);
            finalResolve = null;
            finalReject = null;
        });

        ws.on('close', () => {
            finalReject?.(new Error('Streaming connection closed unexpectedly'));
            finalResolve = null;
            finalReject = null;
        });

        return {
            sendAudio(pcm: Buffer): void {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(pcm);
                }
            },
            onPartial(listener: (partial: StreamingPartial) => void): void {
                partialListeners.push(listener);
            },
            finalize(): Promise<StreamingFinal> {
                return new Promise<StreamingFinal>((resolve, reject) => {
                    finalResolve = resolve;
                    finalReject = reject;
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ action: 'finalize' }));
                    } else {
                        reject(new Error('Streaming connection already closed'));
                    }
                });
            },
            cancel(): void {
                if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                    ws.close();
                }
            },
        };
    }

    async reloadModel(
        model: string,
        device: string = 'auto',
        computeType: string = 'auto',
        beamSize: number = 5,
    ): Promise<void> {
        const formData = new FormData();
        formData.append('model', model);
        formData.append('device', device);
        formData.append('compute_type', computeType);
        formData.append('beam_size', String(beamSize));

        const response = await fetch(`${this.baseUrl}/reload`, {
            method: 'POST',
            headers: { 'X-Extension-Token': this.token },
            body: formData,
            // 30 minutes - same as initial model download ceiling, covers large-v3 on slow networks.
            signal: AbortSignal.timeout(1800000),
        });

        if (!response.ok) {
            throw new Error(`Reload failed: HTTP ${response.status}`);
        }
    }
}
