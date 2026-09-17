export interface CommandResult {
    data: Record<string, unknown>;
    text: string;
}

export interface BinaryCommandResult extends CommandResult {
    textBytes: Buffer | null;
}
