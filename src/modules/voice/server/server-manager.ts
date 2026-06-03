import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as crypto from 'crypto';

import { VOICE_CONFIG_SECTION, VOICE_DEFAULTS } from '../constants';
import {
    modelsDir,
    pythonExecutable,
    serverLogFile,
    serverPortFile,
    serverTokenFile,
} from '../../../shared/server-runtime';

export type ServerStatus = 'stopped' | 'starting' | 'ready' | 'error';

// How long a spawn lock may be held before we consider it stale (e.g. the
// holder crashed mid-spawn without cleaning up).
const SPAWN_LOCK_STALE_MS = 60_000;
// How often to poll for the port/token files while waiting for another window
// to finish spawning.
const SPAWN_LOCK_POLL_INTERVAL_MS = 500;
// Maximum time to wait for another window to finish spawning before giving up
// and attempting to spawn ourselves.
const SPAWN_LOCK_WAIT_TIMEOUT_MS = 90_000;

export class ServerManager implements vscode.Disposable {
    private process: cp.ChildProcess | null = null;
    private _status: ServerStatus = 'stopped';
    private _port: number | null = null;
    private _token: string = '';
    private restartCount: number = 0;
    private restartWindowStart: number = 0;
    private healthCheckTimer: NodeJS.Timeout | null = null;
    private healthFailCount: number = 0;
    private readonly healthFailThreshold = 4;
    private oomDetected: boolean = false;
    private isServerOwner: boolean = false;

    private readonly onStatusChangedEmitter = new vscode.EventEmitter<ServerStatus>();
    readonly onStatusChanged = this.onStatusChangedEmitter.event;

    private externalProgressReport: ((line: string) => void) | null = null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly extensionLog: vscode.OutputChannel,
        private readonly serverLog: vscode.OutputChannel,
    ) {}

    get status(): ServerStatus {
        return this._status;
    }

    get port(): number | null {
        return this._port;
    }

    get token(): string {
        return this._token;
    }

    async start(): Promise<void> {
        if (this._status === 'starting' || this._status === 'ready') {
            return;
        }

        this.setStatus('starting');

        if (await this.tryAdoptExistingServer()) {
            this.extensionLog.appendLine(`[ServerManager] Adopted existing server on port ${this._port}`);
            this.setStatus('ready');
            this.startHealthCheck();
            return;
        }

        // M6: Acquire an exclusive spawn lock so that two windows starting at
        // the same moment do not each spawn their own Python process.
        const lockAcquired = this.acquireSpawnLock();

        if (!lockAcquired) {
            // Another window holds the lock - wait for it to finish spawning,
            // then adopt its server.
            this.extensionLog.appendLine('[ServerManager] Another window is spawning - waiting to adopt...');
            const adopted = await this.waitForSpawnAndAdopt();
            if (adopted) {
                this.extensionLog.appendLine(`[ServerManager] Adopted server spawned by another window on port ${this._port}`);
                this.setStatus('ready');
                this.startHealthCheck();
                return;
            }
            // Timed out waiting - fall through and try to spawn ourselves.
            this.extensionLog.appendLine('[ServerManager] Timed out waiting for other window to spawn; attempting own spawn.');
        }

        try {
            await this.spawnServer();
            this.startHealthCheck();
        } catch (err) {
            this.extensionLog.appendLine(`[ServerManager] Failed to start: ${err}`);
            this.setStatus('error');
        } finally {
            if (lockAcquired) {
                this.releaseSpawnLock();
            }
        }
    }

    // cleanupToken: pass true for a final stop (extension deactivate / window
    // close) to remove the token file.  Pass false (default) for a transient
    // stop before restart so that spawnServer() can reuse the existing token
    // (H3: keeps adopter windows valid across owner restarts).
    async stop(cleanupToken: boolean = false): Promise<void> {
        this.stopHealthCheck();

        if (!this.isServerOwner) {
            // Non-owner: just forget the reference, server keeps running for other windows
            this._port = null;
            this._token = '';
            this.setStatus('stopped');
            return;
        }

        // Try graceful shutdown via HTTP
        if (this._port && this._token) {
            try {
                await this.sendShutdown();
                await this.waitForExit(5000);
            } catch {
                // Fall through to SIGTERM
            }
        }

        if (this.process && !this.process.killed) {
            this.process.kill('SIGTERM');
            await this.waitForExit(3000);
        }

        if (this.process && !this.process.killed) {
            this.process.kill('SIGKILL');
        }

        this.process = null;
        this._port = null;
        this.isServerOwner = false;

        // M5: Always remove the port file so adopters see the server is gone.
        const storageDir = this.context.globalStorageUri.fsPath;
        const portFile = serverPortFile(storageDir);
        if (fs.existsSync(portFile)) {
            try { fs.unlinkSync(portFile); } catch { /* best effort */ }
        }

        // H3: Remove the token file only on final shutdown.  During restart the
        // token file is kept so spawnServer() can reuse the same token, which
        // lets adopter windows skip a re-adopt cycle.
        if (cleanupToken) {
            const tokenFile = this.getTokenFilePath();
            if (fs.existsSync(tokenFile)) {
                try { fs.unlinkSync(tokenFile); } catch { /* best effort */ }
            }
        }

        this.setStatus('stopped');
    }

    async restart(): Promise<void> {
        await this.stop(false);
        await new Promise(resolve => setTimeout(resolve, 500));
        await this.start();
    }

    private getTokenFilePath(): string {
        return serverTokenFile(this.context.globalStorageUri.fsPath);
    }

    private async tryAdoptExistingServer(): Promise<boolean> {
        const storageDir = this.context.globalStorageUri.fsPath;
        const portFile = serverPortFile(storageDir);
        const tokenFile = this.getTokenFilePath();

        if (!fs.existsSync(portFile) || !fs.existsSync(tokenFile)) {
            return false;
        }

        const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
        const token = fs.readFileSync(tokenFile, 'utf8').trim();

        if (isNaN(port) || port <= 0 || !token) {
            return false;
        }

        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`, {
                headers: { 'X-Extension-Token': token },
                signal: AbortSignal.timeout(2000),
            });
            if (!response.ok) {
                return false;
            }
            const body = await response.json() as { status: string };
            if (body.status !== 'ready') {
                return false;
            }
        } catch {
            return false;
        }

        this._port = port;
        this._token = token;
        this.isServerOwner = false;
        return true;
    }

    private async spawnServer(): Promise<void> {
        const pythonPath = this.getPythonPath();
        const serverScript = this.getServerScript();
        const storageDir = this.context.globalStorageUri.fsPath;
        const portFile = serverPortFile(storageDir);
        const logFile = serverLogFile(storageDir);

        // H3: Reuse the existing token if the token file is present and valid.
        // This keeps adopter windows valid across owner restarts because they
        // still hold the same token.  Generate a fresh token only when there
        // is no token file (first start or after a clean stop).
        this._token = this.loadOrGenerateToken();

        const config = vscode.workspace.getConfiguration(VOICE_CONFIG_SECTION);
        const model = config.get<string>('model', VOICE_DEFAULTS.model);
        const device = config.get<string>('device', VOICE_DEFAULTS.device);
        const computeType = config.get<string>('computeType', VOICE_DEFAULTS.computeType);
        const beamSize = config.get<number>('beamSize', VOICE_DEFAULTS.beamSize);

        // Remove stale port file
        if (fs.existsSync(portFile)) {
            fs.unlinkSync(portFile);
        }

        const args = [
            serverScript,
            '--port', '0',
            '--model', model,
            '--device', device,
            '--compute-type', computeType,
            '--beam-size', String(beamSize),
            '--storage-dir', modelsDir(storageDir),
            '--token', this._token,
            '--port-file', portFile,
            '--log-file', logFile,
        ];

        this.extensionLog.appendLine(`[ServerManager] Starting: ${pythonPath} ${args.slice(0, 6).join(' ')} ...`);

        let progressReport: ((line: string) => void) | null = null;

        this.process = cp.spawn(pythonPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });

        const forEachLine = (data: Buffer): void => {
            const raw = data.toString();
            for (const line of raw.split(/[\r\n]+/)) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                this.serverLog.appendLine(`${trimmed}`);
                progressReport?.(trimmed);
                this.externalProgressReport?.(trimmed);
            }
        };

        this.oomDetected = false;

        const detectOom = (line: string): void => {
            if (line.toLowerCase().includes('out of memory')) {
                this.oomDetected = true;
            }
        };

        this.process.stdout?.on('data', (data: Buffer) => forEachLine(data));
        this.process.stderr?.on('data', (data: Buffer) => {
            forEachLine(data);
            for (const line of data.toString().split(/[\r\n]+/)) {
                detectOom(line);
            }
        });

        this.process.on('exit', (code) => {
            this.extensionLog.appendLine(`[ServerManager] Process exited with code ${code}`);
            if (this._status !== 'stopped') {
                this.handleUnexpectedExit();
            }
        });

        try {
            // Wait for port file (up to 60 seconds)
            const port = await this.waitForPortFile(portFile, 60000);
            this._port = port;

            // Wait for /health to return ready with visible progress notification.
            // cancellable:true lets the user abort a stuck model download/load.
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Loading model "${model}"...`,
                    cancellable: true,
                },
                async (progress, cancellationToken) => {
                    progress.report({ message: 'Waiting for server...' });

                    let lastPercent = 0;
                    const tqdmPattern = /(\d{1,3})%\|[^|]*\|\s*(\S+?)\s*\/\s*(\S+?)(?:\s|\[|$)/;
                    // Bytes: 405M, 3.09G, 462k, 2.67MiB. File counters look like plain integers (2/4).
                    const byteSizePattern = /^\d+(?:\.\d+)?\s*[kKmMgGtT]i?[bB]?$/;

                    progressReport = (line: string): void => {
                        const tqdmMatch = line.match(tqdmPattern);
                        if (tqdmMatch) {
                            const total = tqdmMatch[3];
                            if (!byteSizePattern.test(total)) {
                                return;
                            }
                            const percent = Math.min(100, parseInt(tqdmMatch[1], 10));
                            const current = tqdmMatch[2];
                            const delta = Math.max(0, percent - lastPercent);
                            lastPercent = percent;
                            progress.report({
                                message: `Downloading model: ${percent}% (${current}/${total})`,
                                increment: delta,
                            });
                            return;
                        }

                        if (line.includes('Loading model')) {
                            progress.report({ message: 'Loading model into memory...' });
                        } else if (line.includes('on cuda') || line.includes('on cpu')) {
                            progress.report({ message: 'Model loaded, warming up...' });
                        }
                    };

                    try {
                        // 30 minutes is enough for the 3GB large-v3 model on a slow connection.
                        await this.waitForReady(1800000, cancellationToken);
                    } finally {
                        progressReport = null;
                    }
                }
            );
        } catch (err) {
            if (this.process && !this.process.killed) {
                this.extensionLog.appendLine('[ServerManager] Killing child process after startup timeout/error');
                this.process.kill('SIGKILL');
            }
            this.process = null;
            this._port = null;
            throw err;
        }

        this.isServerOwner = true;
        fs.writeFileSync(this.getTokenFilePath(), this._token, 'utf8');

        this.setStatus('ready');
        this.extensionLog.appendLine(`[ServerManager] Ready on port ${this._port}`);
    }

    async runWithModelLoadingProgress<T>(title: string, operation: () => Promise<T>): Promise<T> {
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title,
                cancellable: false,
            },
            async (progress) => {
                progress.report({ message: 'Starting...' });

                let lastPercent = 0;
                const tqdmPattern = /(\d{1,3})%\|[^|]*\|\s*(\S+?)\s*\/\s*(\S+?)(?:\s|\[|$)/;
                const byteSizePattern = /^\d+(?:\.\d+)?\s*[kKmMgGtT]i?[bB]?$/;

                this.externalProgressReport = (line: string): void => {
                    const tqdmMatch = line.match(tqdmPattern);
                    if (tqdmMatch) {
                        const total = tqdmMatch[3];
                        if (!byteSizePattern.test(total)) {
                            // Not a byte progress (file counter, audio seconds during warmup, etc).
                            return;
                        }
                        const percent = Math.min(100, parseInt(tqdmMatch[1], 10));
                        const current = tqdmMatch[2];
                        const delta = Math.max(0, percent - lastPercent);
                        lastPercent = percent;
                        progress.report({
                            message: `Downloading model: ${percent}% (${current}/${total})`,
                            increment: delta,
                        });
                        return;
                    }
                    if (line.includes('Loading model')) {
                        progress.report({ message: 'Loading model into memory...' });
                    } else if (line.includes('on cuda') || line.includes('on cpu')) {
                        progress.report({ message: 'Model loaded, warming up...' });
                    }
                };

                try {
                    return await operation();
                } finally {
                    this.externalProgressReport = null;
                }
            },
        );
    }

    private async waitForPortFile(portFile: string, timeoutMs: number): Promise<number> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (fs.existsSync(portFile)) {
                const content = fs.readFileSync(portFile, 'utf8').trim();
                const port = parseInt(content, 10);
                if (!isNaN(port) && port > 0) {
                    return port;
                }
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        throw new Error('Timed out waiting for server port file');
    }

    private async waitForReady(
        timeoutMs: number,
        cancellationToken?: vscode.CancellationToken,
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (cancellationToken?.isCancellationRequested) {
                throw new Error('Server startup cancelled by user');
            }
            try {
                const status = await this.fetchHealth();
                if (status === 'ready') {
                    return;
                }
            } catch {
                // Server not up yet
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error('Timed out waiting for server to become ready');
    }

    private async fetchHealth(): Promise<string> {
        if (!this._port) {
            throw new Error('No port');
        }
        const response = await fetch(`http://127.0.0.1:${this._port}/health`, {
            headers: { 'X-Extension-Token': this._token },
            signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) {
            throw new Error(`Health check HTTP ${response.status}`);
        }
        const body = await response.json() as { status: string };
        return body.status;
    }

    private startHealthCheck(): void {
        this.healthFailCount = 0;
        this.healthCheckTimer = setInterval(async () => {
            try {
                // Server replied - it is alive regardless of whether it is "ready" or "loading" a model.
                await this.fetchHealth();
                this.healthFailCount = 0;
            } catch {
                if (this._status === 'ready') {
                    this.healthFailCount++;
                    if (this.healthFailCount >= this.healthFailThreshold) {
                        this.extensionLog.appendLine(
                            `[ServerManager] Health check failed ${this.healthFailCount} times, marking error`
                        );
                        this.setStatus('error');
                        if (!this.isServerOwner) {
                            // Owner will respawn; give it a head start then try to adopt
                            this._port = null;
                            this._token = '';
                            setTimeout(() => this.start(), 3000);
                        }
                    }
                }
            }
        }, 2000);
    }

    private stopHealthCheck(): void {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }

    private handleUnexpectedExit(): void {
        this.setStatus('error');
        this.process = null;
        this._port = null;

        if (this.oomDetected) {
            this.oomDetected = false;
            this.extensionLog.appendLine('[ServerManager] GPU out of memory - not restarting.');
            vscode.window.showErrorMessage(
                'Not enough GPU memory to load the model. Try selecting a smaller model in settings.',
                'Open Settings'
            ).then(choice => {
                if (choice === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'sonara.voice.model');
                }
            });
            return;
        }

        const now = Date.now();
        if (now - this.restartWindowStart > 60000) {
            this.restartWindowStart = now;
            this.restartCount = 0;
        }

        this.restartCount++;
        if (this.restartCount <= 3) {
            this.extensionLog.appendLine(
                `[ServerManager] Auto-restarting (attempt ${this.restartCount}/3)...`
            );
            setTimeout(() => this.start(), 2000);
        } else {
            this.extensionLog.appendLine('[ServerManager] Too many restarts, giving up.');
            vscode.window.showErrorMessage(
                'Voice server crashed repeatedly. Click to view logs.',
                'Show Logs'
            ).then(choice => {
                if (choice === 'Show Logs') {
                    this.extensionLog.show();
                }
            });
        }
    }

    private async sendShutdown(): Promise<void> {
        await fetch(`http://127.0.0.1:${this._port}/shutdown`, {
            method: 'POST',
            headers: { 'X-Extension-Token': this._token },
            signal: AbortSignal.timeout(3000),
        });
    }

    private waitForExit(timeoutMs: number): Promise<void> {
        return new Promise(resolve => {
            if (!this.process) {
                resolve();
                return;
            }
            const timer = setTimeout(resolve, timeoutMs);
            this.process.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    // H3: Load a pre-existing token from the token file when available and
    // valid; generate a new one only when the file is absent or unreadable.
    private loadOrGenerateToken(): string {
        const tokenFile = this.getTokenFilePath();
        try {
            if (fs.existsSync(tokenFile)) {
                const existing = fs.readFileSync(tokenFile, 'utf8').trim();
                if (existing.length > 0) {
                    this.extensionLog.appendLine('[ServerManager] Reusing existing token from token file.');
                    return existing;
                }
            }
        } catch {
            // File unreadable or corrupt - fall through to generate a new one.
        }
        this.extensionLog.appendLine('[ServerManager] Generating new token.');
        return crypto.randomBytes(32).toString('hex');
    }

    private getSpawnLockFilePath(): string {
        return path.join(this.context.globalStorageUri.fsPath, 'server-spawn.lock');
    }

    // M6: Try to acquire an exclusive spawn lock.
    // Returns true  when we own the lock (caller must call releaseSpawnLock()).
    // Returns false when another window already holds a fresh lock.
    private acquireSpawnLock(): boolean {
        const lockFile = this.getSpawnLockFilePath();

        // If a lock file exists, check whether it is stale.
        if (fs.existsSync(lockFile)) {
            try {
                const stat = fs.statSync(lockFile);
                const ageMs = Date.now() - stat.mtimeMs;
                if (ageMs < SPAWN_LOCK_STALE_MS) {
                    // Lock is fresh - another window is actively spawning.
                    return false;
                }
                // Lock is stale - remove it and try to claim below.
                this.extensionLog.appendLine(
                    `[ServerManager] Stale spawn lock detected (age ${Math.round(ageMs / 1000)}s), removing.`
                );
                fs.unlinkSync(lockFile);
            } catch {
                // File disappeared between existsSync and statSync/unlink, or
                // another window removed it first.  That's fine - fall through.
            }
        }

        // Try to create the lock file with exclusive flag (O_EXCL).
        try {
            fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
            return true;
        } catch {
            // Another window won the race for the lock.
            return false;
        }
    }

    private releaseSpawnLock(): void {
        const lockFile = this.getSpawnLockFilePath();
        try {
            if (fs.existsSync(lockFile)) {
                fs.unlinkSync(lockFile);
            }
        } catch {
            // Best-effort cleanup.
        }
    }

    // M6: Poll until the other window writes port/token files and the server
    // responds healthy, then adopt it.  Returns false on timeout.
    private async waitForSpawnAndAdopt(): Promise<boolean> {
        const deadline = Date.now() + SPAWN_LOCK_WAIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, SPAWN_LOCK_POLL_INTERVAL_MS));
            if (await this.tryAdoptExistingServer()) {
                return true;
            }
        }
        return false;
    }

    private getPythonPath(): string {
        return pythonExecutable(this.context.globalStorageUri.fsPath);
    }

    private getServerScript(): string {
        return path.join(this.context.extensionPath, 'src', 'modules', 'voice', 'python', 'server.py');
    }

    private setStatus(status: ServerStatus): void {
        this._status = status;
        this.onStatusChangedEmitter.fire(status);
    }

    dispose(): void {
        this.stopHealthCheck();
        this.onStatusChangedEmitter.dispose();
        if (this.isServerOwner) {
            // M5: dispose() reached us as owner before stop() could run
            // (e.g. the extension host crashed or deactivate was not awaited).
            // Kill the process and clean up both runtime files.
            if (this.process && !this.process.killed) {
                this.process.kill('SIGKILL');
            }
            const storageDir = this.context.globalStorageUri.fsPath;
            const portFile = serverPortFile(storageDir);
            if (fs.existsSync(portFile)) {
                try { fs.unlinkSync(portFile); } catch { /* best effort */ }
            }
            const tokenFile = this.getTokenFilePath();
            if (fs.existsSync(tokenFile)) {
                try { fs.unlinkSync(tokenFile); } catch { /* best effort */ }
            }
        }
        // If stop() already ran as owner, it cleared isServerOwner and removed
        // the port file; the token file was intentionally kept for the restart
        // case and will have been removed by a subsequent stop() on full exit
        // via the graceful shutdown path (deactivate → stop → dispose).
        // Non-owner windows do nothing here - the server keeps running.
    }
}
