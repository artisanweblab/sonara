import { StashEntry, StashReader } from '../git/stash-reader';
import { StashHistory } from './stash-history';

export class PassStashes {
    private loaded: Promise<StashEntry[]> | undefined;

    constructor(
        private readonly reader: StashReader,
        private readonly previous: ReadonlySet<string> | null,
        private readonly history: StashHistory,
    ) {}

    entries(): Promise<StashEntry[]> {
        if (!this.loaded) {
            this.loaded = this.reader.list().then(entries => {
                this.history.observe(entries);
                return entries;
            });
        }
        return this.loaded;
    }

    isLoaded(): boolean {
        return this.loaded !== undefined;
    }

    async has(oid: string): Promise<boolean> {
        return (await this.entries()).some(entry => entry.oid === oid);
    }

    async wasRemovedInThisPass(oid: string): Promise<boolean> {
        return this.previous !== null && this.previous.has(oid) && !(await this.has(oid));
    }

    async oids(): Promise<Set<string>> {
        return new Set((await this.entries()).map(entry => entry.oid));
    }

    async madeAfterReview(repoPath: string, recordId: string): Promise<StashEntry[]> {
        return this.history.madeAfterReview(repoPath, recordId, await this.entries());
    }
}
