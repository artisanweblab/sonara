import * as vscode from 'vscode';
import type { API, GitExtension } from './git-api';

const GIT_EXTENSION_ID = 'vscode.git';

export type GitApiLoad = { api: API } | { reason: string };

export async function loadGitApi(): Promise<GitApiLoad> {
    const extension = vscode.extensions.getExtension<GitExtension>(GIT_EXTENSION_ID);
    if (!extension) {
        return { reason: 'the built-in Git extension (vscode.git) is not installed or is disabled' };
    }
    try {
        const gitExtension = extension.isActive ? extension.exports : await extension.activate();
        return gitExtension.enabled
            ? { api: gitExtension.getAPI(1) }
            : { reason: 'the built-in Git extension is turned off by the git.enabled setting' };
    } catch (error) {
        return { reason: `the built-in Git extension failed to start: ${error instanceof Error ? error.message : String(error)}` };
    }
}
