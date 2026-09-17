import { ContentLoader } from '../git/content-loader';
import { textBlobReferences } from '../store/record-codec';
import { ReviewBlobStore } from '../store/review-blob-store';
import { FrontierRecord, ScannedFile } from '../types';
import { FileStack, buildFileStack } from './file-stack';

export class FileStackBuilder {
    constructor(
        private readonly loader: ContentLoader,
        private readonly blobs: ReviewBlobStore,
    ) {}

    async build(file: ScannedFile, head: string, record: FrontierRecord | null): Promise<FileStack> {
        const snapshot = await this.loader.snapshot(file.path, head);
        const blobs = new Map<string, Buffer>();
        if (record?.kind === 'text' && file.kind !== 'opaque') {
            for (const hash of textBlobReferences(record)) {
                blobs.set(hash, await this.blobs.read(hash));
            }
        }
        return buildFileStack(file.kind, head, record, snapshot, blobs);
    }
}
