import * as vscode from 'vscode';
import { ChannelOutputLog, registerLoggedCommand } from '../../../shared/output-log';
import { CommandDeps } from './types';

const PRODUCT = 'Sonara Voice';

export function registerVoiceCommand(
    deps: Pick<CommandDeps, 'extensionLog'>,
    command: string,
    handler: (...args: unknown[]) => unknown,
): vscode.Disposable {
    return registerLoggedCommand(new ChannelOutputLog(deps.extensionLog), PRODUCT, command, handler);
}
