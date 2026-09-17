export type StorageErrorKind = 'blob-missing' | 'blob-corrupt' | 'blob-unreadable' | 'record-unreadable' | 'record-newer-version' | 'record-read-only';

export class ReviewStorageError extends Error {
    constructor(
        readonly kind: StorageErrorKind,
        message: string,
        readonly blobHash: string | null = null,
    ) {
        super(message);
        this.name = 'ReviewStorageError';
    }
}
