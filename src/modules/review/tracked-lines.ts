import { FileMeasure, measureFile } from '../../shared/file-measure';
import { GitReader } from './git/git-reader';
import { mapLimit } from './model/map-limit';

const MEASURE_CONCURRENCY = 16;

export class TrackedLines {
    private readonly measures = new Map<string, FileMeasure>();
    private tracked = new Set<string>();
    private isReady = false;

    constructor(
        private readonly reader: GitReader,
        private readonly scopeSpec: string,
        private readonly absolutePath: (repoPath: string) => string,
    ) {}

    total(): number | null {
        if (!this.isReady) {
            return null;
        }
        return Array.from(this.measures.values()).reduce((sum, measure) => sum + (measure.lines ?? 0), 0);
    }

    async refreshAll(): Promise<void> {
        this.tracked = new Set(await this.reader.nulRecords(['ls-files', '-z', '--cached', '--', this.scopeSpec]));
        for (const repoPath of Array.from(this.measures.keys())) {
            if (!this.tracked.has(repoPath)) {
                this.measures.delete(repoPath);
            }
        }
        await this.measure(Array.from(this.tracked));
        this.isReady = true;
    }

    async refreshPaths(repoPaths: readonly string[]): Promise<void> {
        await this.measure(repoPaths.filter(repoPath => this.tracked.has(repoPath)));
    }

    private async measure(repoPaths: readonly string[]): Promise<void> {
        await mapLimit(repoPaths, MEASURE_CONCURRENCY, async repoPath => {
            const measure = await measureFile(this.absolutePath(repoPath), this.measures.get(repoPath));
            if (measure) {
                this.measures.set(repoPath, measure);
            } else {
                this.measures.delete(repoPath);
            }
        });
    }
}
