import * as path from 'path';

export const SONARA_ROOT = '.vscode/sonara';

export const TASKS_FOLDER_NAME = `${SONARA_ROOT}/tasks`;
export const VOICE_LOG_FOLDER_NAME = `${SONARA_ROOT}/voice-log`;
export const VOICE_TRANSCRIPTS_FOLDER_NAME = `${SONARA_ROOT}/voice-transcripts`;
export const TIME_TRACKER_FOLDER_NAME = `${SONARA_ROOT}/time-tracker`;
export const REVIEW_FOLDER_NAME = `${SONARA_ROOT}/review`;

export const REVIEW_CLI_NAME = 'sonara-review';

export function sonaraRootIn(projectPath: string): string {
    return path.join(projectPath, SONARA_ROOT);
}

export function reviewDirIn(projectPath: string): string {
    return path.join(projectPath, ...REVIEW_FOLDER_NAME.split('/'));
}
