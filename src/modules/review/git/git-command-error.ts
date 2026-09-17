export class GitCommandError extends Error {
    constructor(
        readonly args: readonly string[],
        readonly exitCode: number | null,
        readonly stderr: string,
    ) {
        super(`git ${args[0]} failed with exit code ${exitCode}: ${stderr.trim()}`);
    }
}
