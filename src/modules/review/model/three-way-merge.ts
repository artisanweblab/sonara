import { RangeHunk } from '../types';
import { diffSegments, firstLineIndex } from './line-diff';

type Side = 'ours' | 'theirs';

interface SideHunk {
    side: Side;
    hunk: RangeHunk;
    start: number;
    end: number;
}

interface Cluster {
    start: number;
    end: number;
    ours: RangeHunk[];
    theirs: RangeHunk[];
}

function sideHunks(base: readonly string[], other: readonly string[], side: Side): SideHunk[] {
    return diffSegments(base, other).map(hunk => {
        const start = firstLineIndex(hunk.oldStart, hunk.oldLines);
        return { side, hunk, start, end: start + hunk.oldLines };
    });
}

function clusterHunks(hunks: readonly SideHunk[]): Cluster[] {
    const ordered = [...hunks].sort((a, b) => a.start - b.start || a.end - b.end);
    const clusters: Cluster[] = [];
    for (const entry of ordered) {
        const last = clusters[clusters.length - 1];
        const cluster = last && entry.start <= last.end ? last : { start: entry.start, end: entry.end, ours: [], theirs: [] };
        if (cluster !== last) {
            clusters.push(cluster);
        }
        cluster.end = Math.max(cluster.end, entry.end);
        cluster[entry.side].push(entry.hunk);
    }
    return clusters;
}

function regionVersion(base: readonly string[], side: readonly string[], hunks: readonly RangeHunk[], start: number, end: number): string[] {
    const result: string[] = [];
    let position = start;
    for (const hunk of hunks) {
        const oldIndex = firstLineIndex(hunk.oldStart, hunk.oldLines);
        const newIndex = firstLineIndex(hunk.newStart, hunk.newLines);
        result.push(...base.slice(position, oldIndex));
        result.push(...side.slice(newIndex, newIndex + hunk.newLines));
        position = oldIndex + hunk.oldLines;
    }
    result.push(...base.slice(position, end));
    return result;
}

export function mergeKeepingOurs(base: readonly string[], ours: readonly string[], theirs: readonly string[]): string[] {
    const clusters = clusterHunks([...sideHunks(base, ours, 'ours'), ...sideHunks(base, theirs, 'theirs')]);
    const segments: string[] = [];
    let cursor = 0;
    for (const cluster of clusters) {
        segments.push(...base.slice(cursor, cluster.start));
        const region = cluster.ours.length === 0
            ? regionVersion(base, theirs, cluster.theirs, cluster.start, cluster.end)
            : regionVersion(base, ours, cluster.ours, cluster.start, cluster.end);
        segments.push(...region);
        cursor = cluster.end;
    }
    segments.push(...base.slice(cursor));
    return segments;
}
