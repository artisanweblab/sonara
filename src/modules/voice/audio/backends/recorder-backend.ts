import * as cp from 'child_process';

export interface AudioInputDevice {
    id: string;
    label: string;
    isDefault: boolean;
}

/**
 * Per-platform audio capture backend. Owns the «how» of spawning a recorder
 * process for the current OS; AudioRecorder owns the «when» (state machine,
 * timing, lifecycle). Add a new platform by implementing this interface and
 * registering it in createRecorderBackend().
 */
export interface RecorderBackend {
    readonly id: string;

    /**
     * Verify the backend can run (tools installed, binaries downloaded, etc).
     * Throw with a user-actionable message if not.
     */
    ensureReady(): Promise<void>;

    /** Spawn a process that writes a 16kHz mono s16 WAV file to outputFile. */
    spawnWavToFile(outputFile: string, deviceId: string | null): cp.ChildProcess;

    /** Spawn a process that streams 16kHz mono s16le raw PCM to stdout. */
    spawnPcmStream(deviceId: string | null): cp.ChildProcess;

    listInputDevices(): Promise<AudioInputDevice[]>;

    /** true=muted, false=not muted, null=unknown (backend cannot determine). */
    isSourceMuted(deviceId: string | null): Promise<boolean | null>;
}
