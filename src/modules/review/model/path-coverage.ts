export class PathCoverage {
    private readonly paths: ReadonlySet<string>;

    constructor(repoPaths: Iterable<string>) {
        this.paths = new Set(repoPaths);
    }

    covers(repoPath: string): boolean {
        let current = repoPath;
        for (;;) {
            if (this.paths.has(current)) {
                return true;
            }
            const separator = current.lastIndexOf('/');
            if (separator < 0) {
                return false;
            }
            current = current.slice(0, separator);
        }
    }
}
