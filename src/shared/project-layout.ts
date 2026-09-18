import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureDir } from './fs-utils';
import { TASKS_README_CONTENT } from '../modules/tasks/templates/tasks-readme';
import { VOCABULARY_TEMPLATE } from '../modules/voice/templates/vocabulary-template';
import { VOICE_TRANSCRIPTS_README_CONTENT } from '../modules/voice/templates/voice-transcripts-readme';
import { TIME_TRACKER_README_CONTENT } from '../modules/time-tracker/templates/time-tracker-readme';
import { REVIEW_README_CONTENT } from '../modules/review/templates/review-readme';
import {
    REVIEW_FOLDER_NAME,
    SONARA_ROOT,
    TASKS_FOLDER_NAME,
    TIME_TRACKER_FOLDER_NAME,
    VOICE_LOG_FOLDER_NAME,
    VOICE_TRANSCRIPTS_FOLDER_NAME,
    reviewDirIn,
    sonaraRootIn,
} from './sonara-paths';

export { REVIEW_FOLDER_NAME, TASKS_FOLDER_NAME, TIME_TRACKER_FOLDER_NAME, VOICE_LOG_FOLDER_NAME, VOICE_TRANSCRIPTS_FOLDER_NAME };

const ROOT_README_FILE = 'README.md';

const ROOT_README_CONTENT = `# Sonara

This folder is created and maintained by the Sonara VS Code extension. It holds project-scoped data for these tools:

- \`tasks/\` - markdown task files (one task per file).
- \`voice-log/\` - dictation log + project-specific Whisper vocabulary.
- \`voice-transcripts/\` - file transcripts.
- \`time-tracker/\` - per-day time tracking data.
- \`review/\` - review levels of uncommitted changes (written only by the extension; agents must not write here or touch the git stage).

Whether this folder (or parts of it) is committed to git is up to your project. The extension does not manage \`.gitignore\` - add the paths you want to ignore to your project's \`.gitignore\` if needed. Voice data may contain personal recordings; consider excluding \`voice-log/\` and \`voice-transcripts/\` from shared repositories.

If your workspace has multiple folders, switch between them using the Active Project selector at the top of the Sonara sidebar. Each folder has its own independent dataset.

## For AI agents

- Before creating, modifying, or closing any task in \`tasks/\`, read \`tasks/README.md\` for the file format and rules.
- \`vocabulary.md\` biases Whisper dictation across the whole project (voice-log, voice-transcripts, dictated task input). One term per line; \`#\` lines are comments. When the user corrects a misrecognized term, propose adding it. Write to the file only on explicit confirmation.
- The owner reviews your uncommitted changes in levels with the Sonara Review panel. Run \`review/sonara-review levels\` (read-only, prints JSON) to see which parts the owner already accepted, and read \`review/README.md\` for the rest of the commands. Never write in \`review/\` and never change the git stage.
`;

export function sonaraRoot(folder: vscode.WorkspaceFolder): string {
    return sonaraRootIn(folder.uri.fsPath);
}

export function tasksDir(folder: vscode.WorkspaceFolder): string {
    return path.join(folder.uri.fsPath, TASKS_FOLDER_NAME);
}

export function voiceLogDir(folder: vscode.WorkspaceFolder): string {
    return path.join(folder.uri.fsPath, VOICE_LOG_FOLDER_NAME);
}

export function voiceLogFile(folder: vscode.WorkspaceFolder): string {
    return path.join(voiceLogDir(folder), 'voice-log.jsonl');
}

export function vocabularyFile(folder: vscode.WorkspaceFolder): string {
    return path.join(sonaraRoot(folder), 'vocabulary.md');
}

export function transcriptsDir(folder: vscode.WorkspaceFolder): string {
    return path.join(folder.uri.fsPath, VOICE_TRANSCRIPTS_FOLDER_NAME);
}

export function timeTrackerDir(folder: vscode.WorkspaceFolder): string {
    return path.join(folder.uri.fsPath, TIME_TRACKER_FOLDER_NAME);
}

export function timeTrackerDaysDir(folder: vscode.WorkspaceFolder): string {
    return path.join(timeTrackerDir(folder), 'days');
}

export function reviewDir(folder: vscode.WorkspaceFolder): string {
    return reviewDirIn(folder.uri.fsPath);
}

interface SeedFile {
    path: string;
    content: string;
    earlierGeneratedHashes: readonly string[] | null;
}

const EARLIER_ROOT_README_HASHES = [
    '52ee6ec5cbbf781f3b9dfd6679e7aba130065301106f3bfdeb6f6198dc5e26bb',
    '12bed207b7b76e12a296a56c174d586f93a4fe2551a0ad89b946a6e58a6227f9',
    'b26ca1a9b0d8a58a590d6fe2d011b6ed6e62d395d6dd15c97662a3a62c8969c1',
    'afa3d378ef3e132d1194a65058aa1d626cc2b8fdca5525d851cc958e4b07a2c9',
];
const EARLIER_TASKS_README_HASHES = [
    '5cb91741a307b16015a1cab6b0078e1027f516cff67e2ad7068ab127de43b67f',
    '388d840f608d131fea66ff9c340912e32dd14f4ad14b76dcf9d35c1b58da0c65',
    '0a5833f6844661d5c8fc7fbd506479a102e13300daae08b3989fb9df8bf7bd02',
    '725307ca6048394fdd86dab4de5dafac192ee50d510926f5736ee66f96a425c3',
    '66f1c80b50d5e4b52f7ebc5dc175d04760257d1cadaee3fee0b24b6675e2abdc',
    '1ea86364130fdba3dc03230316d00ae47709fd4af4b8b331f4e5c39dddf77778',
];
const EARLIER_TRANSCRIPTS_README_HASHES = ['58792007f054af91d0efeb7a8865be53aa5402bb52802bf6e642852304af2467'];
const EARLIER_TIME_TRACKER_README_HASHES = ['a179edcf53f1128b4ad062fda532e720b0a766206809963537254dbc9ee3966b'];
const EARLIER_REVIEW_README_HASHES = [
    'c5c823b155f0e4caa4bc9870b5997bc37ec025ba94c4ee895f3239945a048136',
    'ba563f2fda81f90746dab3a22aecd434fb149ba024bb84b20556e6c80e20d68b',
    '3f3a170f667af9f0301e8343e2f6e886f0f4fdce9b947d651077325d975fa470',
    '795a780e1e1774abedd7f7a3ec0be23662fbb913100d0731a294ca9a746f1cd5',
    '2a439debd9c5314451f8b3c2cf2f79066435e73c96ba6cf7413aa21e2b9e36ed',
];
const UPDATE_SUFFIX = '.new';

const warnedUpdates = new Set<string>();

function refreshSeed(seed: SeedFile): string | null {
    if (!fs.existsSync(seed.path)) {
        fs.writeFileSync(seed.path, seed.content, 'utf8');
        return null;
    }
    if (seed.earlierGeneratedHashes === null) {
        return null;
    }
    const existing = fs.readFileSync(seed.path);
    if (existing.equals(Buffer.from(seed.content, 'utf8'))) {
        return null;
    }
    if (seed.earlierGeneratedHashes.includes(createHash('sha256').update(existing).digest('hex'))) {
        fs.writeFileSync(seed.path, seed.content, 'utf8');
        return null;
    }
    const updatePath = `${seed.path}${UPDATE_SUFFIX}`;
    if (!fs.existsSync(updatePath) || fs.readFileSync(updatePath, 'utf8') !== seed.content) {
        fs.writeFileSync(updatePath, seed.content, 'utf8');
    }
    return updatePath;
}

export function ensureSonaraProject(folder: vscode.WorkspaceFolder): void {
    ensureDir(sonaraRoot(folder));
    ensureDir(tasksDir(folder));
    ensureDir(voiceLogDir(folder));
    ensureDir(transcriptsDir(folder));
    ensureDir(timeTrackerDir(folder));
    ensureDir(timeTrackerDaysDir(folder));
    ensureDir(reviewDir(folder));

    const seeds: SeedFile[] = [
        { path: path.join(sonaraRoot(folder), ROOT_README_FILE), content: ROOT_README_CONTENT, earlierGeneratedHashes: EARLIER_ROOT_README_HASHES },
        { path: path.join(tasksDir(folder), ROOT_README_FILE), content: TASKS_README_CONTENT, earlierGeneratedHashes: EARLIER_TASKS_README_HASHES },
        { path: path.join(transcriptsDir(folder), ROOT_README_FILE), content: VOICE_TRANSCRIPTS_README_CONTENT, earlierGeneratedHashes: EARLIER_TRANSCRIPTS_README_HASHES },
        { path: path.join(timeTrackerDir(folder), ROOT_README_FILE), content: TIME_TRACKER_README_CONTENT, earlierGeneratedHashes: EARLIER_TIME_TRACKER_README_HASHES },
        { path: path.join(reviewDir(folder), ROOT_README_FILE), content: REVIEW_README_CONTENT, earlierGeneratedHashes: EARLIER_REVIEW_README_HASHES },
        { path: vocabularyFile(folder), content: VOCABULARY_TEMPLATE, earlierGeneratedHashes: null },
    ];

    const updates = seeds.map(refreshSeed).filter((updatePath): updatePath is string => updatePath !== null && !warnedUpdates.has(updatePath));
    if (updates.length > 0) {
        updates.forEach(updatePath => warnedUpdates.add(updatePath));
        const names = updates.map(updatePath => path.relative(folder.uri.fsPath, updatePath)).join(', ');
        void vscode.window.showWarningMessage(`Sonara: newer versions of generated README files were written next to your edited copies: ${names}. Compare them and replace your copies if nothing of yours needs to stay.`);
    }
}

export { ensureDir };
