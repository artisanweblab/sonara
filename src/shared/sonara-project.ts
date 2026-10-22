import * as vscode from 'vscode';

export interface SonaraProject {
    readonly uri: vscode.Uri;
    readonly name: string;
}
