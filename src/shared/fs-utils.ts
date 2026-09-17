import * as fsSync from 'fs';
import * as vscode from 'vscode';
import { atomicWriteFile } from './atomic-write';

function toFsPath(target: vscode.Uri | string): string {
    return typeof target === 'string' ? target : target.fsPath;
}

function toUri(target: vscode.Uri | string): vscode.Uri {
    return typeof target === 'string' ? vscode.Uri.file(target) : target;
}

export async function atomicWrite(target: vscode.Uri | string, content: string): Promise<void> {
    await atomicWriteFile(toFsPath(target), content);
}

export async function pathExists(target: vscode.Uri | string): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(toUri(target));
        return true;
    } catch {
        return false;
    }
}

export async function openInEditor(target: vscode.Uri | string): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument(toUri(target));
    return vscode.window.showTextDocument(doc);
}

export function ensureDir(dir: string): void {
    fsSync.mkdirSync(dir, { recursive: true });
}
