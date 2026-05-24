import * as cp from 'child_process';

import { commandExists } from '../../../../shared/command-exists';
import { AudioInputDevice, RecorderBackend } from './recorder-backend';

type LinuxRecorderTool = 'parecord' | 'arecord';

/**
 * Linux capture via PipeWire/PulseAudio (parecord) or ALSA (arecord) fallback.
 * Device enumeration and mute probing go through pactl (PulseAudio CLI),
 * available with both PipeWire and PulseAudio.
 */
export class LinuxPulseBackend implements RecorderBackend {
    readonly id = 'linux-pulse';
    private resolvedTool: LinuxRecorderTool | null = null;

    async ensureReady(): Promise<void> {
        await this.resolveTool();
    }

    spawnWavToFile(outputFile: string, deviceId: string | null): cp.ChildProcess {
        const tool = this.resolvedTool;
        if (!tool) {
            throw new Error('LinuxPulseBackend not ready - call ensureReady() first');
        }
        const args = tool === 'parecord'
            ? this.parecordWavArgs(outputFile, deviceId)
            : this.arecordWavArgs(outputFile, deviceId);
        return cp.spawn(tool, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    }

    spawnPcmStream(deviceId: string | null): cp.ChildProcess {
        const tool = this.resolvedTool;
        if (!tool) {
            throw new Error('LinuxPulseBackend not ready - call ensureReady() first');
        }
        const args = tool === 'parecord'
            ? this.parecordPcmArgs(deviceId)
            : this.arecordPcmArgs(deviceId);
        return cp.spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    }

    async listInputDevices(): Promise<AudioInputDevice[]> {
        if (!(await commandExists('pactl'))) {
            return [];
        }
        const [defaultName, listOutput] = await Promise.all([
            execCapture('pactl get-default-source').then(out => out.trim()).catch(() => ''),
            execCapture('pactl list sources').catch(() => ''),
        ]);
        if (!listOutput) {
            return [];
        }

        const devices: AudioInputDevice[] = [];
        const blocks = listOutput.split(/\n(?=Source #)/);
        for (const block of blocks) {
            const nameMatch = block.match(/^\s*Name:\s*(.+)$/m);
            if (!nameMatch) {
                continue;
            }
            const name = nameMatch[1].trim();
            // .monitor sources are loopback (system audio) - separate feature, hide for now.
            if (name.endsWith('.monitor')) {
                continue;
            }
            const descMatch = block.match(/^\s*Description:\s*(.+)$/m);
            devices.push({
                id: name,
                label: descMatch ? descMatch[1].trim() : name,
                isDefault: name === defaultName,
            });
        }
        return devices;
    }

    async isSourceMuted(deviceId: string | null): Promise<boolean | null> {
        if (!(await commandExists('pactl'))) {
            return null;
        }
        let source: string | null = deviceId;
        if (!source) {
            try {
                source = (await execCapture('pactl get-default-source')).trim();
            } catch {
                return null;
            }
        }
        if (!source || !/^[A-Za-z0-9._:-]+$/.test(source)) {
            return null;
        }
        try {
            const out = await execCapture(`pactl get-source-mute ${source}`);
            const match = out.match(/Mute:\s*(yes|no)/i);
            if (!match) {
                return null;
            }
            return match[1].toLowerCase() === 'yes';
        } catch {
            return null;
        }
    }

    private async resolveTool(): Promise<LinuxRecorderTool> {
        if (this.resolvedTool) {
            return this.resolvedTool;
        }
        for (const tool of ['parecord', 'arecord'] as LinuxRecorderTool[]) {
            if (await commandExists(tool)) {
                this.resolvedTool = tool;
                return tool;
            }
        }
        throw new Error(
            'No audio recorder found. Install parecord: sudo dnf install pulseaudio-utils'
        );
    }

    private parecordWavArgs(outputFile: string, deviceId: string | null): string[] {
        const args = ['--format=s16le', '--rate=16000', '--channels=1', '--file-format=wav'];
        if (deviceId) {
            args.push(`--device=${deviceId}`);
        }
        args.push(outputFile);
        return args;
    }

    private arecordWavArgs(outputFile: string, deviceId: string | null): string[] {
        const args = ['-f', 'S16_LE', '-r', '16000', '-c', '1'];
        if (deviceId) {
            args.push('-D', deviceId);
        }
        args.push(outputFile);
        return args;
    }

    private parecordPcmArgs(deviceId: string | null): string[] {
        const args = ['--format=s16le', '--rate=16000', '--channels=1', '--raw'];
        if (deviceId) {
            args.push(`--device=${deviceId}`);
        }
        return args;
    }

    private arecordPcmArgs(deviceId: string | null): string[] {
        const args = ['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw'];
        if (deviceId) {
            args.push('-D', deviceId);
        }
        args.push('-');
        return args;
    }
}

function execCapture(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.exec(command, { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(stdout);
        });
    });
}
