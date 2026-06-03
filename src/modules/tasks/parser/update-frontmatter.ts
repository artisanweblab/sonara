import * as vscode from 'vscode';
import matter from 'gray-matter';
import { atomicWrite } from '../../../shared/fs-utils';

export type FrontmatterPatch = Record<string, string | Date | string[] | null>;

/** Strip UTF-8 BOM and leading HTML comments, matching parse-task-file normalization. */
function normalizeRaw(raw: string): string {
    const stripped = raw.replace(/^﻿/, '');
    let rest = stripped.replace(/^\s+/, '');
    while (rest.startsWith('<!--')) {
        const end = rest.indexOf('-->');
        if (end === -1) {
            break;
        }
        rest = rest.slice(end + 3).replace(/^\s+/, '');
    }
    return rest;
}

export async function updateFrontmatter(fileUri: vscode.Uri, patch: FrontmatterPatch): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    const raw = Buffer.from(bytes).toString('utf8');
    const normalized = normalizeRaw(raw);

    if (!/^---\s*\r?\n/.test(normalized)) {
        // File has no YAML frontmatter - do not silently append one.
        throw new Error(`Cannot update frontmatter: file has no YAML frontmatter block (${fileUri.fsPath})`);
    }

    const parsed = matter(normalized);
    const data = parsed.data as Record<string, unknown>;

    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete data[key];
        } else {
            data[key] = value;
        }
    }

    const output = matter.stringify(parsed.content, data);
    await atomicWrite(fileUri, output);
}
