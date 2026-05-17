export const TRANSCRIPTS_PANEL_STYLES = `
.transcript-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 10px;
}

.transcript-card {
    padding: 8px 10px;
    margin-bottom: 2px;
    border-radius: 3px;
    cursor: default;
    transition: background 0.1s;
}
.transcript-card:last-child { margin-bottom: 0; }
.transcript-card:hover { background: var(--vscode-list-hoverBackground); }

.transcript-name {
    font-size: 12px;
    font-weight: 500;
    color: var(--vscode-foreground);
    word-break: break-word;
    margin-bottom: 3px;
    cursor: pointer;
}
.transcript-name:hover { text-decoration: underline; }

.transcript-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    flex-wrap: wrap;
}

.transcript-summary {
    margin-top: 4px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--vscode-foreground);
    opacity: 0.85;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
}

.transcript-time { font-variant-numeric: tabular-nums; }
.transcript-duration { opacity: 0.7; }

.empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    gap: 8px;
    text-align: center;
    padding: 10px 20px;
}

.empty-icon { font-size: 32px; opacity: 0.4; }
`;
