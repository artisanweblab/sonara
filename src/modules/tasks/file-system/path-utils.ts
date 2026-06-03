import * as vscode from 'vscode';
import * as fs from 'fs/promises';

function toKebabCase(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^\p{L}0-9\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
}

export async function generateUniqueFilename(tasksDir: vscode.Uri, title: string): Promise<string> {
    const base = toKebabCase(title) || 'task';
    let candidate = `${base}.md`;
    let counter = 2;
    // Use O_EXCL (flag 'wx') to atomically claim the filename. On EEXIST
    // increment the counter and retry instead of checking existence first.
    for (;;) {
        const targetPath = vscode.Uri.joinPath(tasksDir, candidate).fsPath;
        try {
            const handle = await fs.open(targetPath, 'wx');
            await handle.close();
            return candidate;
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
                candidate = `${base}-${counter}.md`;
                counter += 1;
            } else {
                throw err;
            }
        }
    }
}
