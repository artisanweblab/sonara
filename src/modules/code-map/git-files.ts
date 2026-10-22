import { execFile } from 'child_process';
import * as path from 'path';

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export interface LineChange {
    added: number;
    removed: number;
}

export class NotGitRepositoryError extends Error {}

function run(cwd: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', [...args], { cwd, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (!error) {
                resolve(stdout);
                return;
            }
            reject(/not a git repository/i.test(stderr) ? new NotGitRepositoryError(stderr.trim()) : new Error(`git ${args.join(' ')} failed: ${stderr.trim() || error.message}`));
        });
    });
}

function splitNul(output: string): string[] {
    return output.split('\0').filter(entry => entry.length > 0);
}

export class GitFiles {
    constructor(private readonly folderPath: string) {}

    async trackedFiles(): Promise<string[]> {
        return splitNul(await run(this.folderPath, ['ls-files', '-z', '--cached']));
    }

    async untrackedFiles(): Promise<string[]> {
        return splitNul(await run(this.folderPath, ['ls-files', '-z', '--others', '--exclude-standard']));
    }

    async hasHead(): Promise<boolean> {
        return (await run(this.folderPath, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim().length > 0;
    }

    async gitDirectories(): Promise<string[]> {
        const [gitDir, commonDir] = (await run(this.folderPath, ['rev-parse', '--absolute-git-dir', '--git-common-dir'])).trim().split('\n');
        return Array.from(new Set([gitDir, path.resolve(this.folderPath, commonDir)]));
    }

    async uncommittedChanges(): Promise<Map<string, LineChange>> {
        const changes = new Map<string, LineChange>();
        for (const entry of splitNul(await run(this.folderPath, ['diff', '--numstat', '-z', '--no-renames', '--relative', 'HEAD']))) {
            const [added, removed, ...rest] = entry.split('\t');
            const repoPath = rest.join('\t');
            if (repoPath && added !== '-') {
                changes.set(repoPath, { added: Number(added), removed: Number(removed) });
            }
        }
        return changes;
    }
}
