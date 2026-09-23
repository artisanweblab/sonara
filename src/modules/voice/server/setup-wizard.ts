import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';

import { commandExists } from '../../../shared/command-exists';
import {
    modelsDir,
    pythonVenvDir,
    pythonExecutable,
    pythonPipExecutable,
} from '../../../shared/server-runtime';

import {
    WHISPER_MODELS,
    MODEL_DESCRIPTIONS,
    GLOBAL_STATE_KEYS,
    type WhisperModel,
    type SetupMode,
} from '../constants';
import { pickOne } from '../../../shared/quick-input';

type DeviceChoice = 'auto' | 'gpu' | 'cpu';
type StreamingModeChoice = 'off' | 'on' | 'adaptive';

interface DeviceOptionItem extends vscode.QuickPickItem {
    value: DeviceChoice;
}

const TORCH_INDEX_CUDA = 'https://download.pytorch.org/whl/cu124';
const TORCH_INDEX_CPU = 'https://download.pytorch.org/whl/cpu';

export class SetupWizard {
    private readonly storageDir: string;
    private readonly venvDir: string;
    private readonly modelsDir: string;
    private readonly logsDir: string;
    private readonly pythonProjectDir: string;
    private readonly serverScriptSrc: string;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.storageDir = context.globalStorageUri.fsPath;
        this.venvDir = pythonVenvDir(this.storageDir);
        this.modelsDir = modelsDir(this.storageDir);
        this.logsDir = path.join(this.storageDir, 'logs');
        this.pythonProjectDir = path.join(context.extensionPath, 'src', 'modules', 'voice', 'python');
        this.serverScriptSrc = path.join(this.pythonProjectDir, 'server.py');
    }

    async isReady(): Promise<boolean> {
        return (
            this.isPythonAvailable() &&
            this.isVenvReady() &&
            this.isSetupComplete() &&
            this.isServerScriptDeployed()
        );
    }

    private isSetupComplete(): boolean {
        return fs.existsSync(path.join(this.venvDir, '.setup-complete'));
    }

    private markSetupComplete(): void {
        fs.writeFileSync(path.join(this.venvDir, '.setup-complete'), 'v1\n', 'utf8');
    }

    private cleanupFailedVenv(): void {
        if (fs.existsSync(this.venvDir)) {
            try {
                fs.rmSync(this.venvDir, { recursive: true, force: true });
            } catch {
                // Ignore - user can reset manually
            }
        }
    }

    async runFirstTimeSetup(): Promise<boolean> {
        const choice = await vscode.window.showInformationMessage(
            'Voice server needs to set up a Python virtual environment. The Whisper model will be downloaded on first use. Continue?',
            'Set up now',
            'Later',
        );
        if (choice !== 'Set up now') {
            return false;
        }

        const modelPick = await this.pickModel();
        if (!modelPick) {
            return false;
        }

        const deviceChoice = await this.pickDevice();
        if (!deviceChoice) {
            return false;
        }

        const streamingChoice = await this.pickStreamingMode();
        if (streamingChoice === undefined) {
            return false;
        }

        const setupMode = await this.resolveSetupMode(deviceChoice);

        const config = vscode.workspace.getConfiguration('sonara.voice');
        await config.update('model', modelPick, vscode.ConfigurationTarget.Global);
        await config.update('streamingMode', streamingChoice, vscode.ConfigurationTarget.Global);

        return await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Setting up voice server...',
                cancellable: false,
            },
            async (progress) => {
                const report = (message: string, increment?: number): void => {
                    progress.report({ message, increment });
                };

                try {
                    report('Checking Python...', 5);
                    const pythonBin = await this.findPython();
                    if (!pythonBin) {
                        vscode.window.showErrorMessage(
                            'Python 3.10+ not found. Install Python 3.10+ and restart VS Code.',
                        );
                        return false;
                    }

                    report(`Creating virtual environment (${pythonBin})...`, 10);
                    await this.createVenv(pythonBin);

                    report('Upgrading pip...', 5);
                    const pip = this.getVenvPip();
                    await this.execStream(
                        `"${pip}" install --upgrade pip`,
                        line => { const msg = this.parsePipLine(line); if (msg) { report(msg); } },
                    );

                    const torchIndex = setupMode === 'gpu' ? TORCH_INDEX_CUDA : TORCH_INDEX_CPU;
                    const torchLabel = setupMode === 'gpu' ? 'CUDA' : 'CPU';
                    report(`Installing PyTorch (${torchLabel} build)... this may take several minutes`, 5);
                    await this.execStream(
                        `"${pip}" install torch --index-url ${torchIndex}`,
                        line => { const msg = this.parsePipLine(line); if (msg) { report(msg); } },
                    );

                    report('Installing server package and dependencies...', 5);
                    await this.execStream(
                        `"${pip}" install "${this.pythonProjectDir}"`,
                        line => { const msg = this.parsePipLine(line); if (msg) { report(msg); } },
                    );

                    report('Deploying server script...', 5);
                    this.deployServerScript();

                    report('Creating directories...', 5);
                    this.ensureDirectories();

                    await this.context.globalState.update(GLOBAL_STATE_KEYS.setupMode, setupMode);

                    this.markSetupComplete();

                    report(`Done! Model "${modelPick}" will be downloaded on first server start.`, 55);
                    return true;
                } catch (err) {
                    this.cleanupFailedVenv();
                    vscode.window.showErrorMessage(
                        `Voice server setup failed: ${err}. The broken environment was removed - run setup again to retry.`,
                    );
                    return false;
                }
            },
        );
    }

    async checkSystemDependencies(): Promise<void> {
        const hasWlCopy = await commandExists('wl-copy');
        if (!hasWlCopy) {
            vscode.window.showWarningMessage(
                'wl-clipboard not found. Copy button will use fallback mode. ' +
                'Install with: sudo dnf install wl-clipboard',
                'Dismiss',
            );
        }
    }

    private async pickModel(): Promise<WhisperModel | undefined> {
        const items: Array<vscode.QuickPickItem & { value: WhisperModel }> = WHISPER_MODELS.map(model => ({
            label: model,
            value: model,
            description: MODEL_DESCRIPTIONS[model].size,
            detail: MODEL_DESCRIPTIONS[model].detail,
        }));

        const picked = await pickOne(items, {
            placeHolder: 'Select Whisper model (can be changed later in settings)',
            title: 'Choose Model',
            matchOnDescription: true,
            matchOnDetail: true,
        });

        return picked?.value;
    }

    private async pickDevice(): Promise<DeviceChoice | undefined> {
        const gpuName = await this.detectGpu();
        const items: DeviceOptionItem[] = [
            {
                label: 'Auto',
                value: 'auto',
                description: 'Detect automatically',
                detail: gpuName
                    ? `NVIDIA GPU detected: ${gpuName}. Will install CUDA build of PyTorch.`
                    : 'No NVIDIA GPU detected. Will install CPU build of PyTorch.',
            },
            {
                label: 'GPU (CUDA)',
                value: 'gpu',
                description: 'Install CUDA 12.4 build of PyTorch',
                detail: gpuName
                    ? `NVIDIA GPU detected: ${gpuName}`
                    : 'WARNING: no NVIDIA GPU detected. Install will likely fail.',
            },
            {
                label: 'CPU only',
                value: 'cpu',
                description: 'Install CPU build of PyTorch',
                detail: 'Smaller download, works everywhere, slower transcription.',
            },
        ];

        const picked = await pickOne(items, {
            placeHolder: 'Select compute device for the Whisper model',
            title: 'Choose Device',
            matchOnDetail: true,
        });

        return picked?.value;
    }

    private async pickStreamingMode(): Promise<StreamingModeChoice | undefined> {
        const items: Array<vscode.QuickPickItem & { value: StreamingModeChoice }> = [
            {
                label: 'Off (classic)',
                value: 'off',
                description: 'Default. Record → stop → transcribe',
                detail: 'Lower CPU/GPU load. You wait a few seconds after stopping before the text appears.',
            },
            {
                label: 'Adaptive',
                value: 'adaptive',
                description: 'Classic on short messages, live on long ones',
                detail: 'Recordings under the threshold (30s by default) use classic mode. Longer ones switch to live automatically. Requires a GPU for the live phase.',
            },
            {
                label: 'On (always live)',
                value: 'on',
                description: 'Text appears in Voice Log while you speak',
                detail: 'Best with a GPU. Works on CPU too but lags behind speech on medium+ models.',
            },
        ];

        const picked = await pickOne(items, {
            placeHolder: 'Choose streaming (live) transcription mode',
            title: 'Streaming Mode',
            matchOnDetail: true,
        });

        return picked?.value;
    }

    private async resolveSetupMode(choice: DeviceChoice): Promise<SetupMode> {
        if (choice === 'gpu') {
            return 'gpu';
        }
        if (choice === 'cpu') {
            return 'cpu';
        }
        const gpu = await this.detectGpu();
        return gpu ? 'gpu' : 'cpu';
    }

    private async detectGpu(): Promise<string | null> {
        try {
            const output = await this.exec('nvidia-smi --query-gpu=name --format=csv,noheader');
            const first = output.split('\n').map(l => l.trim()).filter(Boolean)[0];
            return first ?? null;
        } catch {
            return null;
        }
    }

    private parsePipLine(line: string): string {
        if (line.startsWith('Downloading ')) {
            const pkg = line.slice('Downloading '.length).split('-')[0];
            return `Downloading ${pkg}...`;
        }
        if (line.startsWith('Installing collected packages:')) {
            return line.replace('Installing collected packages:', 'Installing:') + '...';
        }
        if (line.startsWith('Successfully installed')) {
            return line;
        }
        return '';
    }

    private execStream(cmd: string, onLine: (line: string) => void, timeoutMs = 600000): Promise<void> {
        return new Promise((resolve, reject) => {
            const proc = cp.spawn('sh', ['-c', cmd], { timeout: timeoutMs });

            const handle = (data: Buffer): void => {
                data.toString().split('\n')
                    .map(l => l.trim())
                    .filter(Boolean)
                    .forEach(onLine);
            };

            proc.stdout?.on('data', handle);
            proc.stderr?.on('data', handle);
            proc.on('error', reject);
            proc.on('exit', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Process exited with code ${code}`));
                }
            });
        });
    }

    private isPythonAvailable(): boolean {
        return fs.existsSync(this.getVenvPython());
    }

    private isVenvReady(): boolean {
        return fs.existsSync(path.join(this.venvDir, 'pyvenv.cfg'));
    }

    private isServerScriptDeployed(): boolean {
        return fs.existsSync(path.join(this.storageDir, 'server.py'));
    }

    private async findPython(): Promise<string | null> {
        const candidates = ['python3.12', 'python3.11', 'python3.10', 'python3'];
        for (const cmd of candidates) {
            try {
                const version = await this.exec(`${cmd} --version`);
                const match = version.match(/Python (\d+)\.(\d+)/);
                if (match) {
                    const major = parseInt(match[1], 10);
                    const minor = parseInt(match[2], 10);
                    if (major === 3 && minor >= 10) {
                        return cmd;
                    }
                }
            } catch {
                // try next
            }
        }
        return null;
    }

    private async createVenv(pythonBin: string): Promise<void> {
        fs.mkdirSync(this.storageDir, { recursive: true });
        await this.exec(`${pythonBin} -m venv "${this.venvDir}"`);
    }

    private deployServerScript(): void {
        const dest = path.join(this.storageDir, 'server.py');
        fs.copyFileSync(this.serverScriptSrc, dest);
    }

    private ensureDirectories(): void {
        fs.mkdirSync(this.logsDir, { recursive: true });
        fs.mkdirSync(this.modelsDir, { recursive: true });
    }

    private getVenvPython(): string {
        return pythonExecutable(this.storageDir);
    }

    private getVenvPip(): string {
        return pythonPipExecutable(this.storageDir);
    }

    private exec(cmd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            cp.exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(stderr || err.message));
                } else {
                    resolve(stdout);
                }
            });
        });
    }
}
