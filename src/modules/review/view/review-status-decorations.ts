import * as vscode from 'vscode';

export const TREE_ITEM_SCHEME = 'sonara-review-tree';

const STATUS_QUERY_KEY = 'status';

const STATUS_DECORATIONS: Record<string, vscode.FileDecoration> = {
    A: new vscode.FileDecoration('A', 'Added', new vscode.ThemeColor('gitDecoration.addedResourceForeground')),
    M: new vscode.FileDecoration('M', 'Modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')),
    D: new vscode.FileDecoration('D', 'Deleted', new vscode.ThemeColor('gitDecoration.deletedResourceForeground')),
    U: new vscode.FileDecoration('U', 'Conflict', new vscode.ThemeColor('gitDecoration.conflictingResourceForeground')),
};

export function treeItemUri(absolutePath: string, status: string | null): vscode.Uri {
    const uri = vscode.Uri.file(absolutePath).with({ scheme: TREE_ITEM_SCHEME });
    return status ? uri.with({ query: `${STATUS_QUERY_KEY}=${status}` }) : uri;
}

export class ReviewStatusDecorations implements vscode.FileDecorationProvider {
    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme !== TREE_ITEM_SCHEME) {
            return undefined;
        }
        const status = new URLSearchParams(uri.query).get(STATUS_QUERY_KEY);
        return status ? STATUS_DECORATIONS[status] : undefined;
    }
}
