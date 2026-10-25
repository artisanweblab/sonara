import { getNonce } from './nonce';
import { SHARED_STYLES } from './shared-styles';

export interface WebviewHtmlOptions {
    title: string;
    body: string;
    extraStyles?: string;
    script: string;
    mediaSource?: string;
}

export function buildWebviewHtml(options: WebviewHtmlOptions): string {
    const nonce = getNonce();
    const extraStyles = options.extraStyles ?? '';
    const media = options.mediaSource ? ` img-src ${options.mediaSource}; media-src ${options.mediaSource};` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';${media}">
<title>${options.title}</title>
<style nonce="${nonce}">${SHARED_STYLES}${extraStyles}</style>
</head>
<body>
${options.body}
<script nonce="${nonce}">${options.script}</script>
</body>
</html>`;
}
