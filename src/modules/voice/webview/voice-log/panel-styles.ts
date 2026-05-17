export const PANEL_STYLES = `
.log-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 10px;
}

.record-card {
    padding: 8px 10px;
    margin-bottom: 2px;
    border-radius: 3px;
    cursor: default;
    transition: background 0.1s;
}
.record-card:last-child { margin-bottom: 0; }
.record-card:hover { background: var(--vscode-list-hoverBackground); }
.record-card.unread { background: color-mix(in srgb, var(--vscode-charts-green) 8%, transparent); }
.record-card.unread:hover { background: color-mix(in srgb, var(--vscode-charts-green) 14%, transparent); }

.record-card.draft {
    background: color-mix(in srgb, var(--vscode-charts-red) 10%, transparent);
    border-left: 2px solid var(--vscode-charts-red);
}
.record-card.draft:hover { background: color-mix(in srgb, var(--vscode-charts-red) 16%, transparent); }

.record-card.draft[data-mode="transcribing"] {
    background: color-mix(in srgb, var(--vscode-charts-yellow) 10%, transparent);
    border-left: 2px solid var(--vscode-charts-yellow);
}
.record-card.draft[data-mode="transcribing"]:hover {
    background: color-mix(in srgb, var(--vscode-charts-yellow) 16%, transparent);
}

.draft-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--vscode-charts-red);
    animation: pulse 1s ease-in-out infinite;
}
.record-card.draft[data-mode="transcribing"] .draft-dot {
    background: var(--vscode-charts-yellow);
    animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

.draft-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--vscode-charts-red);
}
.record-card.draft[data-mode="transcribing"] .draft-label {
    color: var(--vscode-charts-yellow);
}

.draft-confirmed { color: var(--vscode-foreground); }
.draft-pending { color: var(--vscode-descriptionForeground); font-style: italic; }
.draft-placeholder { color: var(--vscode-descriptionForeground); font-style: italic; opacity: 0.7; }

.unread-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--vscode-charts-green);
    flex-shrink: 0;
}

.record-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    flex-wrap: wrap;
}

.record-time { font-variant-numeric: tabular-nums; }
.record-duration { font-variant-numeric: tabular-nums; opacity: 0.75; }

.record-text {
    font-size: 12px;
    line-height: 1.4;
    color: var(--vscode-foreground);
    word-break: break-word;
    cursor: text;
    user-select: text;
}

.record-text.collapsed {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.record-text.draft-running {
    max-height: calc(1.4em * 2);
    overflow: hidden;
    scroll-behavior: auto;
}

.record-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 4px;
}

.edit-area {
    width: 100%;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-focusBorder);
    color: var(--vscode-input-foreground);
    border-radius: 3px;
    font-size: 12px;
    padding: 4px;
    resize: vertical;
    min-height: 60px;
    font-family: inherit;
    line-height: 1.4;
}

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
