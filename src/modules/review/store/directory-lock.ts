import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProcessIdentity, isProcessGone } from './process-identity';

const OWNER_FILE = 'owner.json';
export const LOCK_RETRY_DELAY_MS = 50;
const LOCK_TIMEOUT_MS = 15000;
const HEARTBEAT_MS = 5000;
const SILENT_LOCK_STALE_MS = 60000;
const OWNERLESS_LOCK_STALE_MS = 10000;
const LIVENESS_CACHE_MS = 2000;

interface LockOwner {
    pid: number;
    hostname: string;
    createdAt: string;
    token: string;
    identity?: string;
}

export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function isErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

async function readOwner(lockDir: string): Promise<Partial<LockOwner> | null> {
    try {
        return JSON.parse(await fs.readFile(path.join(lockDir, OWNER_FILE), 'utf8')) as Partial<LockOwner>;
    } catch {
        return null;
    }
}

export class DirectoryLock {
    private readonly liveness = new Map<string, { isAlive: boolean; checkedAt: number }>();
    private readonly queues = new Map<string, Promise<void>>();

    run<T>(lockDir: string, task: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(lockDir) ?? Promise.resolve();
        const current = previous.then(() => this.runLocked(lockDir, task));
        const settled = current.then(() => undefined, () => undefined);
        this.queues.set(lockDir, settled);
        void settled.then(() => {
            if (this.queues.get(lockDir) === settled) {
                this.queues.delete(lockDir);
            }
        });
        return current;
    }

    private async runLocked<T>(lockDir: string, task: () => Promise<T>): Promise<T> {
        const token = await this.acquire(lockDir);
        const heartbeat = setInterval(() => {
            const now = new Date();
            fs.utimes(lockDir, now, now).catch(() => undefined);
        }, HEARTBEAT_MS);
        try {
            return await task();
        } finally {
            clearInterval(heartbeat);
            await this.release(lockDir, token);
        }
    }

    private async acquire(lockDir: string): Promise<string> {
        const deadline = Date.now() + LOCK_TIMEOUT_MS;
        const token = randomBytes(12).toString('hex');
        const identity = await ProcessIdentity.ofCurrentProcess();
        for (;;) {
            try {
                await fs.mkdir(path.dirname(lockDir), { recursive: true });
                await fs.mkdir(lockDir);
                const owner: LockOwner = { pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString(), token };
                if (identity) {
                    owner.identity = identity;
                }
                await fs.writeFile(path.join(lockDir, OWNER_FILE), JSON.stringify(owner) + '\n', 'utf8');
                return token;
            } catch (error) {
                if (isErrorCode(error, 'ENOENT') && Date.now() <= deadline) {
                    continue;
                }
                if (!isErrorCode(error, 'EEXIST')) {
                    throw error;
                }
            }
            const staleToken = await this.staleToken(lockDir);
            if (staleToken !== null) {
                await this.steal(lockDir, staleToken);
                continue;
            }
            if (Date.now() > deadline) {
                throw new Error(`Sonara Review: timed out waiting for lock ${lockDir}`);
            }
            await delay(LOCK_RETRY_DELAY_MS);
        }
    }

    private async staleToken(lockDir: string): Promise<string | null> {
        let ageMs: number;
        try {
            ageMs = Date.now() - (await fs.stat(lockDir)).mtimeMs;
        } catch {
            return null;
        }
        const owner = await readOwner(lockDir);
        if (!owner || typeof owner.pid !== 'number') {
            return ageMs > OWNERLESS_LOCK_STALE_MS ? owner?.token ?? '' : null;
        }
        const isSameHost = owner.hostname === undefined || owner.hostname === os.hostname();
        let isStale: boolean;
        if (!isSameHost) {
            isStale = ageMs > SILENT_LOCK_STALE_MS;
        } else if (typeof owner.identity === 'string') {
            isStale = !(await this.isAlive(owner.pid, owner.identity));
        } else {
            isStale = isProcessGone(owner.pid) || ageMs > SILENT_LOCK_STALE_MS;
        }
        return isStale ? owner.token ?? '' : null;
    }

    private async isAlive(pid: number, identity: string): Promise<boolean> {
        const key = `${pid}:${identity}`;
        const cached = this.liveness.get(key);
        if (cached && Date.now() - cached.checkedAt < LIVENESS_CACHE_MS) {
            return cached.isAlive;
        }
        const isAlive = await ProcessIdentity.isOwnerAlive(pid, identity);
        this.liveness.set(key, { isAlive, checkedAt: Date.now() });
        return isAlive;
    }

    private async steal(lockDir: string, staleToken: string): Promise<void> {
        const tombstone = `${lockDir}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
        try {
            await fs.rename(lockDir, tombstone);
        } catch {
            return;
        }
        const owner = await readOwner(tombstone);
        if ((owner?.token ?? '') !== staleToken) {
            await fs.rename(tombstone, lockDir).catch(() => undefined);
            return;
        }
        await fs.rm(tombstone, { recursive: true, force: true });
    }

    private async release(lockDir: string, token: string): Promise<void> {
        const owner = await readOwner(lockDir);
        if (owner?.token === token) {
            await fs.rm(lockDir, { recursive: true, force: true });
        }
    }
}
