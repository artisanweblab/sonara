import { SYMLINK_MODE } from '../model/file-state';
import { mapLimit } from '../model/map-limit';
import { BatchOutputParser } from './batch-output-parser';
import { ConversionProbe } from './conversion-probe';
import { GitReader } from './git-reader';

const FILTERED_CONCURRENCY = 8;

export interface ObjectRequest {
    repoPath: string;
    mode: string;
    objectId: string;
}

export function objectKey(request: ObjectRequest): string {
    return `${request.mode === SYMLINK_MODE ? 'link' : 'file'}\0${request.objectId}\0${request.repoPath}`;
}

export class ObjectBatchReader {
    constructor(
        private readonly reader: GitReader,
        private readonly probe: ConversionProbe,
    ) {}

    async readMany(requests: readonly ObjectRequest[]): Promise<Map<string, Buffer>> {
        const unique = new Map<string, ObjectRequest>();
        requests.forEach(request => unique.set(objectKey(request), request));
        const files = Array.from(unique.values()).filter(request => request.mode !== SYMLINK_MODE);
        const unconverted = await this.probe.unconvertedPaths(files.map(request => request.repoPath), 'checkout');
        const raw: ObjectRequest[] = [];
        const filtered: ObjectRequest[] = [];
        for (const request of unique.values()) {
            (request.mode === SYMLINK_MODE || unconverted.has(request.repoPath) ? raw : filtered).push(request);
        }
        const contents = new Map<string, Buffer>();
        const rawObjects = await this.batch(Array.from(new Set(raw.map(request => request.objectId))));
        raw.forEach(request => contents.set(objectKey(request), rawObjects.get(request.objectId) as Buffer));
        await mapLimit(filtered, FILTERED_CONCURRENCY, async request => {
            contents.set(objectKey(request), await this.reader.buffer(['cat-file', '--filters', `--path=${request.repoPath}`, request.objectId]));
        });
        return contents;
    }

    private async batch(objectIds: readonly string[]): Promise<Map<string, Buffer>> {
        const objects = new Map<string, Buffer>();
        if (objectIds.length === 0) {
            return objects;
        }
        const parser = new BatchOutputParser();
        await this.reader.chunks(['cat-file', '--batch'], Buffer.from(objectIds.map(objectId => `${objectId}\n`).join(''), 'utf8'), chunk => parser.push(chunk));
        parser.finish(objectIds.length).forEach((content, position) => {
            if (content === null) {
                throw new Error(`Sonara Review: git object ${objectIds[position]} is missing`);
            }
            objects.set(objectIds[position], content);
        });
        return objects;
    }
}
