import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { OBJECT_ID_PATTERN, SYMLINK_MODE, sha256 } from '../model/file-state';
import { mapLimit } from '../model/map-limit';
import { ConversionProbe } from './conversion-probe';
import { IndexGit } from './index-git';

const WRITE_CONCURRENCY = 32;
const FILTERED_CONCURRENCY = 8;

export interface BlobHashRequest {
    repoPath: string;
    mode: string;
    content: Buffer;
}

function checkedObjectId(value: string, repoPath: string): string {
    const objectId = value.trim();
    if (!OBJECT_ID_PATTERN.test(objectId)) {
        throw new Error(`Sonara Review: git hash-object returned an unexpected object id for ${repoPath}`);
    }
    return objectId;
}

export class BlobHasher {
    constructor(
        private readonly git: IndexGit,
        private readonly probe: ConversionProbe,
    ) {}

    async hashMany(requests: readonly BlobHashRequest[]): Promise<string[]> {
        const objectIds = new Array<string>(requests.length);
        if (requests.length === 0) {
            return objectIds;
        }
        const unconverted = await this.probe.unconvertedPaths(requests.filter(request => request.mode !== SYMLINK_MODE).map(request => request.repoPath), 'commit');
        const raw: number[] = [];
        const filtered: number[] = [];
        requests.forEach((request, position) => (request.mode === SYMLINK_MODE || unconverted.has(request.repoPath) ? raw : filtered).push(position));
        await this.hashRaw(requests, raw, objectIds);
        await mapLimit(filtered, FILTERED_CONCURRENCY, async position => {
            const request = requests[position];
            const output = await this.git.run(['hash-object', '-w', '--stdin', `--path=${request.repoPath}`], {}, request.content);
            objectIds[position] = checkedObjectId(output.toString('utf8'), request.repoPath);
        });
        return objectIds;
    }

    private async hashRaw(requests: readonly BlobHashRequest[], positions: readonly number[], objectIds: string[]): Promise<void> {
        if (positions.length === 0) {
            return;
        }
        const byHash = new Map<string, number[]>();
        for (const position of positions) {
            const hash = sha256(requests[position].content);
            byHash.set(hash, [...(byHash.get(hash) ?? []), position]);
        }
        const groups = Array.from(byHash.values());
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sonara-review-'));
        try {
            const files = groups.map((_group, index) => path.join(directory, String(index)));
            await mapLimit(groups.map((group, index) => ({ group, file: files[index] })), WRITE_CONCURRENCY, item => fs.writeFile(item.file, requests[item.group[0]].content));
            const output = await this.git.run(['hash-object', '-w', '--no-filters', '--stdin-paths'], {}, Buffer.from(files.map(file => `${file}\n`).join(''), 'utf8'));
            const lines = output.toString('utf8').split('\n').filter(line => line.length > 0);
            if (lines.length !== groups.length) {
                throw new Error(`Sonara Review: git hash-object returned ${lines.length} object ids for ${groups.length} files`);
            }
            groups.forEach((group, index) => {
                const objectId = checkedObjectId(lines[index], requests[group[0]].repoPath);
                group.forEach(position => {
                    objectIds[position] = objectId;
                });
            });
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    }
}
