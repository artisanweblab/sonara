import { execFile } from 'child_process';
import * as fs from 'fs/promises';

const STAT_START_TIME_FIELD = 19;
const QUERY_TIMEOUT_MS = 3000;

function query(command: string, args: readonly string[]): Promise<string | null> {
    return new Promise(resolve => {
        execFile(command, args, { timeout: QUERY_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
            const value = stdout.trim();
            resolve(error || value === '' ? null : value);
        });
    });
}

async function linuxIdentity(pid: number): Promise<string | null> {
    try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
        const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[STAT_START_TIME_FIELD];
        const bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
        return startTime ? `${bootId}:${startTime}` : null;
    } catch {
        return null;
    }
}

export function isProcessGone(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
}

export class ProcessIdentity {
    private static own: Promise<string | null> | undefined;

    static ofCurrentProcess(): Promise<string | null> {
        if (!ProcessIdentity.own) {
            ProcessIdentity.own = ProcessIdentity.of(process.pid);
        }
        return ProcessIdentity.own;
    }

    static of(pid: number): Promise<string | null> {
        switch (process.platform) {
            case 'linux':
                return linuxIdentity(pid);
            case 'win32':
                return query('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`]);
            default:
                return query('ps', ['-o', 'lstart=', '-p', String(pid)]);
        }
    }

    static async isOwnerAlive(pid: number, identity: string | undefined): Promise<boolean> {
        if (isProcessGone(pid)) {
            return false;
        }
        if (!identity) {
            return true;
        }
        const current = await ProcessIdentity.of(pid);
        return current === null || current === identity;
    }
}
