import * as fs from 'fs';

export const VOCABULARY_FILE = 'vocabulary.md';

const MAX_WORDS = 150;

export function loadVocabularyFromFile(filePath: string): string[] {
    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch {
        return [];
    }
    const terms: string[] = [];
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        terms.push(line);
        if (terms.length >= MAX_WORDS) {
            break;
        }
    }
    return terms;
}

export function buildInitialPrompt(vocabulary: string[]): string | null {
    if (vocabulary.length === 0) {
        return null;
    }
    return `Common terms in this context: ${vocabulary.join(', ')}.`;
}
