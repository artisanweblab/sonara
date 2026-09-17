import * as vscode from 'vscode';
import { StorageInspector, StorageReport } from '../store/storage-inspector';

const LISTED_DETAILS = 20;

function counted(count: number, singular: string, plural: string): string {
    return `${count} ${count === 1 ? singular : plural}`;
}

function listDetails(output: vscode.OutputChannel, lines: readonly string[]): void {
    lines.slice(0, LISTED_DETAILS).forEach(line => output.appendLine(`      ${line}`));
    if (lines.length > LISTED_DETAILS) {
        output.appendLine(`      ... and ${lines.length - LISTED_DETAILS} more`);
    }
}

function reportLines(output: vscode.OutputChannel, report: StorageReport): void {
    output.appendLine(`  ${counted(report.records, 'review record', 'review records')}, ${report.dormantRecords} stashed away`);
    output.appendLine(`  ${counted(report.blobs, 'accepted version', 'accepted versions')} stored, ${report.referencedBlobs} of them still in use`);
    output.appendLine(`  ${counted(report.orphanBlobs, 'accepted version is', 'accepted versions are')} no longer needed by any record, they are cleaned up automatically`);
    output.appendLine(`  ${counted(report.quarantinedRecords, 'record', 'records')} set aside as unreadable, ${counted(report.journals, 'unfinished move journal', 'unfinished move journals')}`);
    if (report.foreignBlobFiles > 0) {
        output.appendLine(`  ${counted(report.foreignBlobFiles, 'file', 'files')} in the blobs folder are not accepted versions and are never touched`);
    }
    if (report.dangling.length === 0) {
        output.appendLine('  No record points at a missing accepted version.');
    } else {
        output.appendLine(`  ${counted(report.dangling.length, 'record points', 'records point')} at an accepted version that is gone:`);
        listDetails(output, report.dangling.map(reference => `${reference.repoPath} (${reference.where})`));
        output.appendLine('      Open those files in the Review panel: their changes start again from New and the record is cleaned up.');
    }
    if (report.unreadableRecords.length > 0) {
        output.appendLine(`  ${counted(report.unreadableRecords.length, 'record cannot', 'records cannot')} be read:`);
        listDetails(output, report.unreadableRecords);
    }
    if (report.unreadableDirectories.length > 0) {
        output.appendLine(`  ${counted(report.unreadableDirectories.length, 'folder cannot', 'folders cannot')} be read, nothing is cleaned up while that lasts:`);
        listDetails(output, report.unreadableDirectories.map(failure => `${failure.directory}: ${failure.reason}`));
    }
}

export async function executeCheckStorage(output: vscode.OutputChannel, reviewRoot: string | undefined): Promise<void> {
    output.show(true);
    if (!reviewRoot) {
        output.appendLine('Review storage check: no project folder is open.');
        return;
    }
    output.appendLine(`Review storage check for ${reviewRoot}`);
    try {
        reportLines(output, await new StorageInspector(reviewRoot).inspect());
    } catch (error) {
        output.appendLine(`  The check could not finish: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }
    output.appendLine('  Nothing was changed, this check only reads.');
}
