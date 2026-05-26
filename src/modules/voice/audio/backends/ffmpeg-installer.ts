import * as cp from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { URL } from 'url';
import * as vscode from 'vscode';

const FFMPEG_DOWNLOAD_URL =
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
const INSTALL_SUBDIR = 'ffmpeg';
const MAX_REDIRECTS = 5;

/**
 * Manages a self-contained ffmpeg.exe inside the extension's globalStorage.
 * Used by WindowsFfmpegBackend. Other platforms rely on system tools and do
 * not need this installer.
 */
export class FfmpegInstaller {
    constructor(private readonly context: vscode.ExtensionContext) {}

    binaryPath(): string {
        return path.join(this.installRoot(), 'bin', 'ffmpeg.exe');
    }

    isInstalled(): boolean {
        return fs.existsSync(this.binaryPath());
    }

    async ensureInstalled(): Promise<string> {
        if (this.isInstalled()) {
            return this.binaryPath();
        }
        const choice = await vscode.window.showInformationMessage(
            'Voice recording on Windows needs ffmpeg. Download it into the extension storage now? (~80 MB)',
            { modal: true },
            'Download',
        );
        if (choice !== 'Download') {
            throw new Error('ffmpeg installation cancelled. Voice recording requires ffmpeg on Windows.');
        }
        await this.downloadAndExtract();
        if (!this.isInstalled()) {
            throw new Error('ffmpeg download finished but binary was not found after extraction.');
        }
        this.invitePickMicrophone();
        return this.binaryPath();
    }

    /**
     * Delete the installed copy. Next ensureInstalled() will re-prompt and
     * re-download. Used by the «Reinstall ffmpeg» command for recovery from
     * a corrupted binary (failed download, AV quarantine, partial extract).
     */
    async wipe(): Promise<void> {
        await fs.promises.rm(this.installRoot(), { recursive: true, force: true });
    }

    private invitePickMicrophone(): void {
        // Non-blocking. The default device works fine; user can stay or pick.
        vscode.window
            .showInformationMessage(
                'ffmpeg installed. Pick your microphone or stay on system default.',
                'Select microphone',
            )
            .then(choice => {
                if (choice === 'Select microphone') {
                    vscode.commands.executeCommand('sonara.voice.changeAudioInput');
                }
            });
    }

    private installRoot(): string {
        return path.join(this.context.globalStorageUri.fsPath, INSTALL_SUBDIR);
    }

    private async downloadAndExtract(): Promise<void> {
        const root = this.installRoot();
        await fs.promises.mkdir(root, { recursive: true });
        const zipPath = path.join(root, 'ffmpeg.zip');

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Installing ffmpeg',
                cancellable: false,
            },
            async (progress) => {
                progress.report({ message: 'Downloading...' });
                await downloadWithRedirects(FFMPEG_DOWNLOAD_URL, zipPath, (received, total) => {
                    if (total > 0) {
                        progress.report({ message: `Downloading ${(received / 1024 / 1024).toFixed(1)} MB of ${(total / 1024 / 1024).toFixed(1)} MB` });
                    } else {
                        progress.report({ message: `Downloading ${(received / 1024 / 1024).toFixed(1)} MB` });
                    }
                });
                progress.report({ message: 'Extracting...' });
                await extractZipViaPowerShell(zipPath, root);
                await fs.promises.unlink(zipPath).catch(() => undefined);
                await this.flattenLayout();
            },
        );
    }

    /**
     * The BtbN archive extracts as ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe.
     * Move the inner bin/ to <root>/bin/ so binaryPath() stays stable.
     */
    private async flattenLayout(): Promise<void> {
        const root = this.installRoot();
        if (fs.existsSync(path.join(root, 'bin', 'ffmpeg.exe'))) {
            return;
        }
        const entries = await fs.promises.readdir(root, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const innerBin = path.join(root, entry.name, 'bin');
            if (fs.existsSync(path.join(innerBin, 'ffmpeg.exe'))) {
                await fs.promises.rename(innerBin, path.join(root, 'bin'));
                await fs.promises.rm(path.join(root, entry.name), { recursive: true, force: true });
                return;
            }
        }
    }
}

function downloadWithRedirects(
    url: string,
    destPath: string,
    onProgress: (received: number, total: number) => void,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const visit = (currentUrl: string, redirectsLeft: number): void => {
            const parsed = new URL(currentUrl);
            const request = https.get(
                {
                    protocol: parsed.protocol,
                    hostname: parsed.hostname,
                    port: parsed.port,
                    path: parsed.pathname + parsed.search,
                    headers: { 'User-Agent': 'sidequest-vscode-extension' },
                },
                (response) => {
                    const status = response.statusCode ?? 0;
                    if (status >= 300 && status < 400 && response.headers.location) {
                        response.resume();
                        if (redirectsLeft <= 0) {
                            reject(new Error('Too many redirects while downloading ffmpeg.'));
                            return;
                        }
                        const next = new URL(response.headers.location, currentUrl).toString();
                        visit(next, redirectsLeft - 1);
                        return;
                    }
                    if (status !== 200) {
                        response.resume();
                        reject(new Error(`ffmpeg download failed: HTTP ${status}`));
                        return;
                    }
                    const total = parseInt(response.headers['content-length'] ?? '0', 10);
                    let received = 0;
                    const out = fs.createWriteStream(destPath);
                    response.on('data', (chunk: Buffer) => {
                        received += chunk.length;
                        onProgress(received, total);
                    });
                    response.pipe(out);
                    out.on('finish', () => out.close(() => resolve()));
                    out.on('error', reject);
                    response.on('error', reject);
                },
            );
            request.on('error', reject);
        };
        visit(url, MAX_REDIRECTS);
    });
}

function extractZipViaPowerShell(zipPath: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const script = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
        cp.execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { windowsHide: true },
            (err, _stdout, stderr) => {
                if (err) {
                    reject(new Error(`Failed to extract ffmpeg archive: ${stderr || err.message}`));
                    return;
                }
                resolve();
            },
        );
    });
}
