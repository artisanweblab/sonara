import * as vscode from 'vscode';
import { describeError } from './error-description';

export interface OutputLog {
    info(message: string): void;
    error(message: string, error: unknown): void;
}

export type ArgumentsDescriber = (args: readonly unknown[]) => string;

function describeArgument(value: unknown): string {
    if (value instanceof vscode.Uri) {
        return value.toString();
    }
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

function describeArgumentsPlainly(args: readonly unknown[]): string {
    return args.map(describeArgument).join(' ');
}

export class ChannelOutputLog implements OutputLog {
    constructor(private readonly channel: vscode.OutputChannel) {}

    info(message: string): void {
        this.channel.appendLine(message);
    }

    error(message: string, error: unknown): void {
        this.channel.appendLine(`ERROR ${message}: ${describeError(error)}`);
    }
}

export function registerLoggedCommand(
    log: OutputLog,
    product: string,
    command: string,
    handler: (...args: unknown[]) => unknown,
    describeArguments: ArgumentsDescriber = describeArgumentsPlainly,
): vscode.Disposable {
    return vscode.commands.registerCommand(command, async (...args: unknown[]) => {
        log.info(`Command ${command} ${describeArguments(args)}`.trimEnd());
        try {
            await handler(...args);
        } catch (error) {
            log.error(`Command ${command} failed`, error);
            await vscode.window.showErrorMessage(`${product}: ${command} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
}
