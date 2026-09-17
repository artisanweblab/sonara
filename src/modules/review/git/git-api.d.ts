// Trimmed from https://raw.githubusercontent.com/microsoft/vscode/main/extensions/git/src/api/git.d.ts (MIT, Copyright (c) Microsoft Corporation)

import { Event, Uri } from 'vscode';

export interface Git {
    readonly path: string;
}

export interface Ref {
    readonly name?: string;
    readonly commit?: string;
}

export type Branch = Ref;

export interface Change {
    readonly uri: Uri;
    readonly originalUri: Uri;
    readonly renameUri: Uri | undefined;
    readonly status: number;
}

export interface RepositoryState {
    readonly HEAD: Branch | undefined;
    readonly mergeChanges: Change[];
    readonly indexChanges: Change[];
    readonly workingTreeChanges: Change[];
    readonly untrackedChanges: Change[];
    readonly onDidChange: Event<void>;
}

export interface Repository {
    readonly rootUri: Uri;
    readonly state: RepositoryState;
}

export type APIState = 'uninitialized' | 'initialized';

export interface API {
    readonly state: APIState;
    readonly onDidChangeState: Event<APIState>;
    readonly git: Git;
    readonly repositories: Repository[];
    readonly onDidOpenRepository: Event<Repository>;
    readonly onDidCloseRepository: Event<Repository>;
    toGitUri(uri: Uri, ref: string): Uri;
    getRepository(uri: Uri): Repository | null;
}

export interface GitExtension {
    readonly enabled: boolean;
    readonly onDidChangeEnablement: Event<boolean>;
    getAPI(version: 1): API;
}
