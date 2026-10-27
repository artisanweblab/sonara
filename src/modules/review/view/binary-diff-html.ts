import * as path from 'path';
import { buildWebviewHtml } from '../../../shared/webview/html-template';
import { PLAYER_SYNC_SCRIPT } from './binary-player-sync-script';

export type BinarySideContent =
    | { kind: 'file'; source: string; bytes: number }
    | { kind: 'note'; text: string };

export interface BinarySide {
    label: string;
    content: BinarySideContent;
}

type MediaKind = 'image' | 'audio' | 'video' | 'other';

const MEDIA_EXTENSIONS: ReadonlyArray<[MediaKind, readonly string[]]> = [
    ['image', ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.avif', '.apng']],
    ['audio', ['.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac', '.opus', '.weba']],
    ['video', ['.mp4', '.webm', '.ogv', '.mov', '.m4v']],
];

const STYLES = `
body { padding: 0; margin: 0; }
.sides { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; min-height: 100vh; background: var(--vscode-editorGroup-border); }
.side { display: flex; flex-direction: column; background: var(--vscode-editor-background); min-width: 0; }
.side-header { display: flex; justify-content: space-between; gap: 8px; padding: 6px 12px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-editorGroup-border); }
.side-body { flex: 1; display: flex; align-items: center; justify-content: center; padding: 12px; }
.side-body img, .side-body video { max-width: 100%; max-height: calc(100vh - 64px); object-fit: contain; }
.side-body audio { width: 100%; }
.note { color: var(--vscode-descriptionForeground); text-align: center; }
`;

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mediaKind(fileName: string): MediaKind {
    const extension = path.extname(fileName).toLowerCase();
    return MEDIA_EXTENSIONS.find(([, extensions]) => extensions.includes(extension))?.[0] ?? 'other';
}

function renderContent(content: BinarySideContent, kind: MediaKind): string {
    if (content.kind === 'note') {
        return `<p class="note">${escapeHtml(content.text)}</p>`;
    }
    const source = escapeHtml(content.source);
    switch (kind) {
        case 'image':
            return `<img src="${source}" alt="">`;
        case 'audio':
            return `<audio controls src="${source}"></audio>`;
        case 'video':
            return `<video controls src="${source}"></video>`;
        case 'other':
            return '<p class="note">This file type has no preview.</p>';
    }
}

function renderSide(side: BinarySide, kind: MediaKind): string {
    const size = side.content.kind === 'file' ? `${side.content.bytes.toLocaleString('en-US')} bytes` : '';
    return `<section class="side">
<div class="side-header"><span>${escapeHtml(side.label)}</span><span>${size}</span></div>
<div class="side-body">${renderContent(side.content, kind)}</div>
</section>`;
}

export function buildBinaryDiffHtml(title: string, fileName: string, sides: readonly [BinarySide, BinarySide], mediaSource: string): string {
    const kind = mediaKind(fileName);
    return buildWebviewHtml({
        title: escapeHtml(title),
        body: `<main class="sides">${sides.map(side => renderSide(side, kind)).join('')}</main>`,
        extraStyles: STYLES,
        script: kind === 'audio' || kind === 'video' ? PLAYER_SYNC_SCRIPT : '',
        mediaSource,
    });
}
