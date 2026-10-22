import { FileStats } from './code-map-scanner';
import { CodeMapTotals } from './code-map-tree';

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatSize(bytes: number): string {
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
        value /= 1024;
        unit++;
    }
    const digits = unit === 0 || value >= 10 ? 0 : 1;
    return `${value.toFixed(digits)} ${SIZE_UNITS[unit]}`;
}

function describeChanges(added: number, removed: number): string[] {
    return added > 0 || removed > 0 ? [`+${added} -${removed}`] : [];
}

export function describeTotals(totals: CodeMapTotals): string {
    return [`files: ${totals.files}`, `lines: ${totals.lines}`, formatSize(totals.bytes), ...describeChanges(totals.added, totals.removed)].join(' · ');
}

export function describeFile(stats: FileStats): string {
    const lines = stats.lines === null ? [] : [`lines: ${stats.lines}`];
    return [...lines, formatSize(stats.bytes), ...describeChanges(stats.added, stats.removed)].join(' · ');
}
