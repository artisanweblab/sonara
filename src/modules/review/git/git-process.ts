import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { GitCommandError } from './git-command-error';

const STDERR_LIMIT = 4000;

export interface GitRunOptions {
    stdin?: Buffer | string;
    env?: Readonly<Record<string, string>>;
    allowedExitCodes?: readonly number[];
    onStdout?: (chunk: Buffer) => void;
}

export interface GitRunResult {
    exitCode: number;
    stdout: Buffer;
}

export function spawnGit(gitPath: string, cwd: string, args: readonly string[], env: Readonly<Record<string, string>> = {}): ChildProcessWithoutNullStreams {
    return spawn(gitPath, ['-c', 'core.quotepath=off', ...args], {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}

export function runGit(gitPath: string, cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitRunResult> {
    const child = spawnGit(gitPath, cwd, args, options.env);
    const chunks: Buffer[] = [];
    let stderr = '';
    return new Promise<GitRunResult>((resolve, reject) => {
        let isFailed = false;
        const fail = (error: Error): void => {
            if (!isFailed) {
                isFailed = true;
                child.kill();
                reject(error);
            }
        };
        child.stdout.on('data', (chunk: Buffer) => {
            if (options.onStdout) {
                try {
                    options.onStdout(chunk);
                } catch (error) {
                    fail(error instanceof Error ? error : new Error(String(error)));
                }
            } else {
                chunks.push(chunk);
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            if (stderr.length < STDERR_LIMIT) {
                stderr += chunk.toString('utf8');
            }
        });
        child.on('error', fail);
        child.on('close', code => {
            if (isFailed) {
                return;
            }
            const exitCode = code ?? -1;
            if (!(options.allowedExitCodes ?? [0]).includes(exitCode)) {
                fail(new GitCommandError(args, code, stderr));
                return;
            }
            resolve({ exitCode, stdout: Buffer.concat(chunks) });
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(options.stdin ?? '');
    });
}
