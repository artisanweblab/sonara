import { DiffParser } from '../git/diff-parser';
import { ContentLoader } from '../git/content-loader';
import { DIFF_FLAGS, literal } from '../git/diff-options';
import { GitReader } from '../git/git-reader';
import { EncodedRecord } from '../frontiers/frontier-encoding';
import { FrontierRepository } from '../frontiers/frontier-repository';
import { toSegments } from '../model/segment-codec';
import { SEGMENT_VALUES, Segments } from '../model/ladder-values';
import { LevelFrontiers, STAGED_RANK, emptyFrontiers, frontiersFromLayers } from '../model/level-ladder';
import { hunkContext, hunkKey, splitWorkingLines } from '../model/hunk-key';
import { spliceSegments } from '../model/line-diff';
import { sha256 } from '../model/file-state';
import { ReviewBlobStore } from '../store/review-blob-store';
import { EARLIER_LEVEL_KEYS } from '../store/record-codec';
import { Hunk, STORED_REVIEW_LEVELS, ScannedFile, StoredReviewLevel, reviewLevelRank } from '../types';

interface LegacyMark {
    key: string;
    level: StoredReviewLevel;
    line: number;
}

interface LegacyLayer {
    blob: string;
    base: string;
}

function legacyMarks(raw: unknown): LegacyMark[] {
    const marks = typeof raw === 'object' && raw !== null ? (raw as { marks?: unknown }).marks : null;
    if (!Array.isArray(marks)) {
        return [];
    }
    return (marks as unknown[]).flatMap(entry => {
        const mark = entry as { key?: unknown; level?: unknown; line?: unknown } | null;
        const level = STORED_REVIEW_LEVELS.find(candidate => EARLIER_LEVEL_KEYS[candidate] === mark?.level);
        return mark && typeof mark.key === 'string' && level
            ? [{ key: mark.key, level, line: typeof mark.line === 'number' ? mark.line : 0 }]
            : [];
    });
}

function legacyLayers(raw: unknown): Partial<Record<StoredReviewLevel, LegacyLayer>> {
    const layers = typeof raw === 'object' && raw !== null ? (raw as { layers?: unknown }).layers : null;
    const result: Partial<Record<StoredReviewLevel, LegacyLayer>> = {};
    if (typeof layers !== 'object' || layers === null) {
        return result;
    }
    for (const level of STORED_REVIEW_LEVELS) {
        const layer = (layers as Record<string, unknown>)[EARLIER_LEVEL_KEYS[level]] as { blob?: unknown; base?: unknown } | undefined;
        if (layer && typeof layer.blob === 'string' && typeof layer.base === 'string') {
            result[level] = { blob: layer.blob, base: layer.base };
        }
    }
    return result;
}

export function matchLegacyLevels(keys: readonly string[], marks: readonly LegacyMark[]): (StoredReviewLevel | null)[] {
    const levels: (StoredReviewLevel | null)[] = keys.map(() => null);
    const ordered = [...marks].sort((a, b) => a.line - b.line);
    const groups = new Map<string, number[]>();
    keys.forEach((key, index) => groups.set(key, [...(groups.get(key) ?? []), index]));
    for (const [key, indexes] of groups) {
        const matching = ordered.filter(mark => mark.key === key);
        if (matching.length === indexes.length) {
            indexes.forEach((atomIndex, position) => {
                levels[atomIndex] = matching[position].level;
            });
        }
    }
    return levels;
}

export class LegacyRecordMigrator {
    constructor(
        private readonly reader: GitReader,
        private readonly loader: ContentLoader,
        private readonly repository: FrontierRepository,
        private readonly blobs: ReviewBlobStore,
    ) {}

    async migrate(file: ScannedFile, head: string, raw: unknown): Promise<EncodedRecord> {
        if (file.kind !== 'text') {
            return { record: null, blobs: [] };
        }
        const layers = legacyLayers(raw);
        const frontiers = Object.keys(layers).length > 0
            ? await this.fromLayers(file, layers)
            : await this.fromMarks(file, head, legacyMarks(raw));
        return frontiers ? this.repository.encodeText(file.path, head, { content: frontiers, modes: emptyFrontiers<string>() }) : { record: null, blobs: [] };
    }

    private async fromLayers(file: ScannedFile, layers: Partial<Record<StoredReviewLevel, LegacyLayer>>): Promise<LevelFrontiers<Segments>> {
        const index = (await this.loader.indexSide(file.path)).content ?? Buffer.alloc(0);
        const stack: Segments[] = [];
        stack[STAGED_RANK] = toSegments(index);
        let below = stack[STAGED_RANK];
        let lowerHash = sha256(index);
        for (const level of [...STORED_REVIEW_LEVELS].sort((a, b) => reviewLevelRank(b) - reviewLevelRank(a))) {
            const layer = layers[level];
            const blob = layer && layer.base === lowerHash ? await this.blobs.read(layer.blob).catch(() => null) : null;
            if (layer && blob) {
                below = toSegments(blob);
                lowerHash = layer.blob;
            }
            stack[reviewLevelRank(level)] = below;
        }
        return frontiersFromLayers<Segments>([], stack, SEGMENT_VALUES);
    }

    private async fromMarks(file: ScannedFile, head: string, marks: readonly LegacyMark[]): Promise<LevelFrontiers<Segments> | null> {
        if (marks.length === 0) {
            return null;
        }
        const parser = new DiffParser();
        await this.reader.stream(['diff', head, ...DIFF_FLAGS, '--', literal(file.path)], '\n', line => parser.push(line));
        const change = parser.finish().find(candidate => candidate.path === file.path);
        if (!change || change.isBinary || change.isSubmodule) {
            return null;
        }
        const headContent = (await this.loader.treeSide(file.path, head)).content;
        const worktreeContent = (await this.loader.worktree(file.path, null)).content;
        const workingLines = splitWorkingLines((worktreeContent ?? Buffer.alloc(0)).toString('utf8'));
        const keys = change.hunks.map(hunk => hunkKey(file.path, hunk, hunkContext(hunk, workingLines)));
        const levels = matchLegacyLevels(keys, marks);
        const headSegments = toSegments(headContent);
        const worktreeSegments = toSegments(worktreeContent);
        const stack: Segments[] = [];
        stack[STAGED_RANK] = headSegments;
        for (const minimum of STORED_REVIEW_LEVELS) {
            stack[reviewLevelRank(minimum)] = spliceSegments(
                headSegments,
                worktreeSegments,
                change.hunks.filter((_: Hunk, index: number) => {
                    const level = levels[index];
                    return level !== null && reviewLevelRank(level) >= reviewLevelRank(minimum);
                }),
            );
        }
        return frontiersFromLayers<Segments>(headSegments, stack, SEGMENT_VALUES);
    }
}
