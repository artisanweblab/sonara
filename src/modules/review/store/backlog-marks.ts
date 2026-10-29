import * as fs from 'fs/promises';
import * as path from 'path';
import { isErrorCode } from './directory-lock';

const BACKLOG_FILE_NAME = 'backlog.json';

export class BacklogMarks {
    private readonly paths = new Set<string>();
    private readonly file: string;

    constructor(reviewRoot: string) {
        this.file = path.join(reviewRoot, BACKLOG_FILE_NAME);
    }

    async load(): Promise<void> {
        let content: string;
        try {
            content = await fs.readFile(this.file, 'utf8');
        } catch (error) {
            if (isErrorCode(error, 'ENOENT')) {
                return;
            }
            throw error;
        }
        const parsed: unknown = JSON.parse(content);
        this.paths.clear();
        if (Array.isArray(parsed)) {
            parsed.filter((item): item is string => typeof item === 'string').forEach(item => this.paths.add(item));
        }
    }

    has(repoPath: string): boolean {
        return this.paths.has(repoPath);
    }

    async add(repoPaths: readonly string[]): Promise<void> {
        repoPaths.forEach(repoPath => this.paths.add(repoPath));
        await this.save();
    }

    async remove(repoPaths: readonly string[]): Promise<void> {
        repoPaths.forEach(repoPath => this.paths.delete(repoPath));
        await this.save();
    }

    async retain(present: ReadonlySet<string>): Promise<void> {
        const gone = Array.from(this.paths).filter(repoPath => !present.has(repoPath));
        if (gone.length > 0) {
            await this.remove(gone);
        }
    }

    private async save(): Promise<void> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(Array.from(this.paths).sort(), null, 2), 'utf8');
        await fs.rename(temporary, this.file);
    }
}
