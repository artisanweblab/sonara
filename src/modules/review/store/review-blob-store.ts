import * as fs from 'fs/promises';
import * as path from 'path';
import { sha256 } from '../model/file-state';
import { mapLimit } from '../model/map-limit';
import { DirectoryLock, isErrorCode } from './directory-lock';
import { ReviewStorageError } from './review-storage-error';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const READ_CONCURRENCY = 32;

export function isBlobName(name: string): boolean {
    return HASH_PATTERN.test(name);
}

export class ReviewBlobStore {
    private readonly blobsRoot: string;
    private readonly lockDir: string;
    private readonly lock = new DirectoryLock();

    constructor(reviewRoot: string) {
        this.blobsRoot = path.join(reviewRoot, 'blobs');
        this.lockDir = path.join(reviewRoot, 'blobs.lock');
    }

    withCollectionLock<T>(task: () => Promise<T>): Promise<T> {
        return this.lock.run(this.lockDir, task);
    }

    async exists(hash: string): Promise<boolean> {
        try {
            await fs.access(path.join(this.blobsRoot, hash));
            return true;
        } catch {
            return false;
        }
    }

    async read(hash: string): Promise<Buffer> {
        if (!HASH_PATTERN.test(hash)) {
            throw new ReviewStorageError('blob-corrupt', `Sonara Review: "${hash}" is not a valid blob name`, hash);
        }
        let content: Buffer;
        try {
            content = await fs.readFile(path.join(this.blobsRoot, hash));
        } catch (error) {
            if (isErrorCode(error, 'ENOENT')) {
                throw new ReviewStorageError('blob-missing', `Sonara Review: accepted version ${hash} is missing from the blob store`, hash);
            }
            throw new ReviewStorageError('blob-unreadable', `Sonara Review: accepted version ${hash} could not be read: ${error instanceof Error ? error.message : String(error)}`, hash);
        }
        if (sha256(content) !== hash) {
            throw new ReviewStorageError('blob-corrupt', `Sonara Review: accepted version ${hash} is corrupt, its checksum does not match`, hash);
        }
        return content;
    }

    async readMany(hashes: Iterable<string>): Promise<Map<string, Buffer | ReviewStorageError>> {
        const unique = Array.from(new Set(hashes));
        const loaded = await mapLimit(unique, READ_CONCURRENCY, hash => this.read(hash).catch((error: unknown) =>
            error instanceof ReviewStorageError ? error : new ReviewStorageError('blob-unreadable', `Sonara Review: accepted version ${hash} could not be read: ${String(error)}`, hash)));
        return new Map(unique.map((hash, position) => [hash, loaded[position]]));
    }

    async write(content: Buffer): Promise<string> {
        const hash = sha256(content);
        const target = path.join(this.blobsRoot, hash);
        try {
            if (sha256(await fs.readFile(target)) === hash) {
                return hash;
            }
        } catch (error) {
            if (!isErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
        await fs.mkdir(this.blobsRoot, { recursive: true });
        const temporary = path.join(this.blobsRoot, `.${hash}.${process.pid}.${Date.now()}.tmp`);
        const handle = await fs.open(temporary, 'wx');
        try {
            await handle.writeFile(content);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.rename(temporary, target);
        return hash;
    }

    async modifiedAt(name: string): Promise<number | null> {
        try {
            return (await fs.stat(path.join(this.blobsRoot, name))).mtimeMs;
        } catch {
            return null;
        }
    }

    async list(): Promise<string[]> {
        try {
            return await fs.readdir(this.blobsRoot);
        } catch (error) {
            if (isErrorCode(error, 'ENOENT')) {
                return [];
            }
            throw error;
        }
    }

    async remove(name: string): Promise<void> {
        await fs.rm(path.join(this.blobsRoot, name), { force: true });
    }
}
