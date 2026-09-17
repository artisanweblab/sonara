export const PATHSPEC_CHUNK_COUNT = 200;

const PATHSPEC_CHUNK_CHARS = 6000;

export const DIFF_FLAGS: readonly string[] = [
    '-U0',
    '--raw',
    '--no-abbrev',
    '--no-renames',
    '--no-color',
    '--no-ext-diff',
    '--submodule=short',
    '--src-prefix=a/',
    '--dst-prefix=b/',
];

export function literal(repoPath: string): string {
    return `:(literal)${repoPath}`;
}

export function chunkPathspecs(repoPaths: readonly string[]): string[][] {
    const chunks: string[][] = [];
    let current: string[] = [];
    let length = 0;
    for (const repoPath of repoPaths) {
        const spec = literal(repoPath);
        if (current.length > 0 && (length + spec.length > PATHSPEC_CHUNK_CHARS || current.length >= PATHSPEC_CHUNK_COUNT)) {
            chunks.push(current);
            current = [];
            length = 0;
        }
        current.push(spec);
        length += spec.length + 1;
    }
    if (current.length > 0) {
        chunks.push(current);
    }
    return chunks;
}
