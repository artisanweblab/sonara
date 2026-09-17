const NEWLINE = 0x0a;

export class BatchOutputParser {
    private readonly results: (Buffer | null)[] = [];
    private header: Buffer[] = [];
    private body: Buffer | null = null;
    private filled = 0;
    private isAwaitingTerminator = false;

    push(chunk: Buffer): void {
        let offset = 0;
        while (offset < chunk.length) {
            if (this.isAwaitingTerminator) {
                this.isAwaitingTerminator = false;
                offset++;
                continue;
            }
            if (this.body) {
                const copied = chunk.copy(this.body, this.filled, offset, Math.min(chunk.length, offset + this.body.length - this.filled));
                this.filled += copied;
                offset += copied;
                if (this.filled === this.body.length) {
                    this.results.push(this.body);
                    this.body = null;
                    this.isAwaitingTerminator = true;
                }
                continue;
            }
            const newline = chunk.indexOf(NEWLINE, offset);
            if (newline < 0) {
                this.header.push(chunk.subarray(offset));
                return;
            }
            this.header.push(chunk.subarray(offset, newline));
            offset = newline + 1;
            this.startObject(Buffer.concat(this.header).toString('utf8'));
            this.header = [];
        }
    }

    finish(expected: number): (Buffer | null)[] {
        if (this.body || this.header.length > 0 || this.results.length !== expected) {
            throw new Error(`Sonara Review: git cat-file --batch returned ${this.results.length} of ${expected} objects`);
        }
        return this.results;
    }

    private startObject(header: string): void {
        if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
            this.results.push(null);
            return;
        }
        const size = Number(header.slice(header.lastIndexOf(' ') + 1));
        if (!Number.isInteger(size) || size < 0) {
            throw new Error(`Sonara Review: unexpected git cat-file --batch header "${header}"`);
        }
        if (size === 0) {
            this.results.push(Buffer.alloc(0));
            this.isAwaitingTerminator = true;
            return;
        }
        this.body = Buffer.allocUnsafe(size);
        this.filled = 0;
    }
}
