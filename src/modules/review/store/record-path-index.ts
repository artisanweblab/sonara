export type RecordRoot = 'files' | 'dormant';

export class RecordPathIndex {
    private readonly paths: Record<RecordRoot, Set<string>> = { files: new Set(), dormant: new Set() };

    replace(root: RecordRoot, repoPaths: readonly string[]): void {
        this.paths[root] = new Set(repoPaths);
    }

    set(root: RecordRoot, repoPath: string, exists: boolean): void {
        if (exists) {
            this.paths[root].add(repoPath);
        } else {
            this.paths[root].delete(repoPath);
        }
    }

    list(root: RecordRoot): string[] {
        return Array.from(this.paths[root]);
    }
}
