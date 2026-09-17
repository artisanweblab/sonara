import { StashEntry } from '../git/stash-reader';

interface ConfirmedRecord {
    recordId: string;
    pass: number;
}

export class StashHistory {
    private pass = 0;
    private readonly firstSeen = new Map<string, number>();
    private readonly confirmed = new Map<string, ConfirmedRecord>();

    beginPass(): void {
        this.pass++;
    }

    observe(entries: readonly StashEntry[]): void {
        const current = new Set(entries.map(entry => entry.oid));
        for (const oid of Array.from(this.firstSeen.keys())) {
            if (!current.has(oid)) {
                this.firstSeen.delete(oid);
            }
        }
        for (const oid of current) {
            if (!this.firstSeen.has(oid)) {
                this.firstSeen.set(oid, this.pass);
            }
        }
    }

    confirm(repoPath: string, recordId: string): void {
        if (this.confirmed.get(repoPath)?.recordId !== recordId) {
            this.confirmed.set(repoPath, { recordId, pass: this.pass });
        }
    }

    forget(repoPath: string): void {
        this.confirmed.delete(repoPath);
    }

    madeAfterReview(repoPath: string, recordId: string, entries: readonly StashEntry[]): StashEntry[] {
        const confirmed = this.confirmed.get(repoPath);
        if (!confirmed || confirmed.recordId !== recordId) {
            return [];
        }
        return entries.filter(entry => (this.firstSeen.get(entry.oid) ?? -1) > confirmed.pass);
    }
}
