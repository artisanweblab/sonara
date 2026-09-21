import { MISSING_MODE, contentHash } from '../model/file-state';
import { levelHunks } from '../model/layer-stack';
import { diffSegments, firstLineIndex, joinSegments, mapNewIndexToOld } from '../model/line-diff';
import { FrontierRecord, LevelChange, LevelDocument, ReviewLevel, ScannedFile, reviewLevelRank } from '../types';
import { FileStack, layerHash } from './file-stack';
import { FileStackBuilder } from './file-stack-builder';
import { FileEvaluation, fileChangeId, gitAtoms, levelChanges, scanGeneration, stackAtoms } from './level-changes';

function opaqueBytes(stack: FileStack, rank: number): Buffer | undefined {
    const hash = layerHash(stack.content[rank]);
    const { head, index, worktree } = stack.snapshot;
    for (const side of [worktree, index, head]) {
        if (side.content && contentHash(side.content) === hash) {
            return side.content;
        }
    }
    return undefined;
}

function describeOpaque(hash: string, mode: string): string {
    return mode === MISSING_MODE ? 'File is absent.\n' : `Binary content ${hash}\nMode ${mode}\n`;
}

export class FrontierEvaluator {
    constructor(private readonly builder: FileStackBuilder) {}

    async evaluate(file: ScannedFile, head: string, record: FrontierRecord | null): Promise<FileEvaluation> {
        if (file.kind === 'special' || !record) {
            return { atoms: gitAtoms(file), generation: scanGeneration(file, head) };
        }
        const stack = await this.builder.build(file, head, record);
        return { atoms: stackAtoms(file.path, stack), generation: stack.generation };
    }

    async document(file: ScannedFile, head: string, record: FrontierRecord | null, level: ReviewLevel): Promise<LevelDocument> {
        if (file.kind === 'special') {
            const text = 'This change can only be staged or unstaged as a whole.\n';
            const hasChange = gitAtoms(file).some(atom => atom.level === level);
            return {
                before: text,
                after: text,
                isBeforeMissing: false,
                isAfterMissing: false,
                changes: hasChange ? [{ id: fileChangeId(), line: 0, lineCount: 0, label: 'whole file' }] : [],
                generation: scanGeneration(file, head),
            };
        }
        const stack = await this.builder.build(file, head, record);
        const rank = reviewLevelRank(level);
        const changes: LevelChange[] = levelChanges(file.path, stack, level).map(change => ({
            id: change.id,
            line: change.range ? firstLineIndex(change.range.newStart, change.range.newLines) : 0,
            lineCount: change.range?.newLines ?? 0,
            label: change.label,
        }));
        if (stack.kind === 'opaque') {
            return {
                before: describeOpaque(layerHash(stack.content[rank + 1]), stack.modes[rank + 1]),
                after: describeOpaque(layerHash(stack.content[rank]), stack.modes[rank]),
                binaryBefore: opaqueBytes(stack, rank + 1),
                binaryAfter: opaqueBytes(stack, rank),
                isBeforeMissing: stack.modes[rank + 1] === MISSING_MODE,
                isAfterMissing: stack.modes[rank] === MISSING_MODE,
                changes,
                generation: stack.generation,
            };
        }
        return {
            before: joinSegments(stack.content[rank + 1]),
            after: joinSegments(stack.content[rank]),
            isBeforeMissing: stack.modes[rank + 1] === MISSING_MODE,
            isAfterMissing: stack.modes[rank] === MISSING_MODE,
            changes,
            generation: stack.generation,
        };
    }

    async firstWorkingLine(file: ScannedFile, head: string, record: FrontierRecord | null, level: ReviewLevel): Promise<number> {
        if (file.kind !== 'text') {
            return 0;
        }
        const stack = await this.builder.build(file, head, record);
        const [first] = levelHunks(stack.content, level);
        if (!first) {
            return 0;
        }
        const relation = diffSegments(stack.content[0], stack.content[reviewLevelRank(level)]);
        return mapNewIndexToOld(relation, firstLineIndex(first.newStart, first.newLines));
    }
}
