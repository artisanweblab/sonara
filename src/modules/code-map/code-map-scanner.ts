import * as path from 'path';
import { FileMeasure, measureFile } from '../../shared/file-measure';
import { GitFiles, LineChange } from './git-files';

const MEASURE_BATCH = 64;
const NO_CHANGE: LineChange = { added: 0, removed: 0 };

export interface FileStats {
    path: string;
    bytes: number;
    lines: number | null;
    added: number;
    removed: number;
}

export class CodeMapScanner {
    private readonly git: GitFiles;
    private measures = new Map<string, FileMeasure>();

    constructor(private readonly folderPath: string) {
        this.git = new GitFiles(folderPath);
    }

    gitDirectories(): Promise<string[]> {
        return this.git.gitDirectories();
    }

    async scan(): Promise<FileStats[]> {
        const [tracked, untracked, hasHead] = await Promise.all([this.git.trackedFiles(), this.git.untrackedFiles(), this.git.hasHead()]);
        const changes = hasHead ? await this.git.uncommittedChanges() : new Map<string, LineChange>();
        const added = new Set(hasHead ? untracked : [...tracked, ...untracked]);
        const measures = await this.measure(Array.from(new Set([...tracked, ...untracked])));
        return Array.from(measures, ([repoPath, measure]) => {
            const change = added.has(repoPath) ? { added: measure.lines ?? 0, removed: 0 } : changes.get(repoPath) ?? NO_CHANGE;
            return { path: repoPath, bytes: measure.bytes, lines: measure.lines, added: change.added, removed: change.removed };
        });
    }

    private async measure(repoPaths: readonly string[]): Promise<Map<string, FileMeasure>> {
        const measured = new Map<string, FileMeasure>();
        for (let start = 0; start < repoPaths.length; start += MEASURE_BATCH) {
            const batch = repoPaths.slice(start, start + MEASURE_BATCH);
            const results = await Promise.all(batch.map(repoPath => measureFile(path.join(this.folderPath, repoPath), this.measures.get(repoPath))));
            results.forEach((measure, index) => {
                if (measure) {
                    measured.set(batch[index], measure);
                }
            });
        }
        this.measures = measured;
        return measured;
    }
}
