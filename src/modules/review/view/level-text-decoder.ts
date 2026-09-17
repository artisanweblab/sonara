import * as vscode from 'vscode';
import { CONTENT_ENCODING } from '../model/segment-codec';

const LABELS: Readonly<Record<string, string>> = {
    utf8: 'utf-8',
    utf8bom: 'utf-8',
    koi8r: 'koi8-r',
    koi8u: 'koi8-u',
    macroman: 'macintosh',
    shiftjis: 'shift_jis',
    eucjp: 'euc-jp',
    euckr: 'euc-kr',
    big5hkscs: 'big5',
    cp866: 'ibm866',
};

const LINE_BREAKING_ENCODINGS: ReadonlySet<string> = new Set(['utf16le', 'utf16be']);

function whatwgLabel(encoding: string): string {
    return LABELS[encoding]
        ?? encoding.replace(/^iso8859(\d+)$/, 'iso-8859-$1').replace(/^windows(\d+)$/, 'windows-$1').replace(/^cp(\d+)$/, 'windows-$1');
}

export class LevelTextDecoder {
    private readonly warnedPaths = new Set<string>();

    decode(content: string, fileUri: vscode.Uri): string {
        const bytes = Buffer.from(content, CONTENT_ENCODING);
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
            const configured = vscode.workspace.getConfiguration('files', fileUri).get<string>('encoding', 'utf8');
            if (configured !== 'utf8' && configured !== 'utf8bom' && !LINE_BREAKING_ENCODINGS.has(configured)) {
                try {
                    return new TextDecoder(whatwgLabel(configured)).decode(bytes);
                } catch {
                    this.warn(fileUri, `its files.encoding "${configured}" is not supported here`);
                    return content;
                }
            }
            this.warn(fileUri, 'it is not valid UTF-8 and files.encoding does not name another encoding');
            return content;
        }
    }

    private warn(fileUri: vscode.Uri, reason: string): void {
        if (this.warnedPaths.has(fileUri.fsPath)) {
            return;
        }
        this.warnedPaths.add(fileUri.fsPath);
        void vscode.window.showWarningMessage(`Sonara Review: the level diff of ${vscode.workspace.asRelativePath(fileUri)} is shown byte by byte (Latin-1), because ${reason}. Set files.encoding for this file to read it correctly.`);
    }
}
