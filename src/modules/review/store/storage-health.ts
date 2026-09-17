export type StorageProblemKind = 'record-unreadable' | 'record-newer-version' | 'blob-missing' | 'directory-unreadable';

export interface StorageProblem {
    kind: StorageProblemKind;
    location: string;
    reason: string;
    quarantinedTo: string | null;
}

export type StorageProblemListener = (problem: StorageProblem) => void;

export type ProblemRecheck = () => Promise<boolean>;

interface OpenProblem {
    kind: StorageProblemKind;
    recheck: ProblemRecheck | null;
}

export class StorageHealth {
    private readonly unhealthy = new Map<string, OpenProblem>();
    private readonly listeners: StorageProblemListener[] = [];

    onProblem(listener: StorageProblemListener): void {
        this.listeners.push(listener);
    }

    report(problem: StorageProblem, recheck: ProblemRecheck | null = null): void {
        if (problem.quarantinedTo === null) {
            this.unhealthy.set(problem.location, { kind: problem.kind, recheck });
        } else {
            this.unhealthy.delete(problem.location);
        }
        this.listeners.forEach(listener => listener(problem));
    }

    recovered(location: string): void {
        this.unhealthy.delete(location);
    }

    recoveredDirectoriesUnder(root: string): void {
        for (const [location, problem] of Array.from(this.unhealthy)) {
            if (problem.kind === 'directory-unreadable' && (location === root || location.startsWith(root))) {
                this.unhealthy.delete(location);
            }
        }
    }

    isUnhealthy(location: string): boolean {
        return this.unhealthy.has(location);
    }

    async recheck(): Promise<void> {
        for (const [location, problem] of Array.from(this.unhealthy)) {
            if (problem.recheck && await problem.recheck()) {
                this.unhealthy.delete(location);
            }
        }
    }

    isHealthy(): boolean {
        return this.unhealthy.size === 0;
    }

    unhealthyLocations(): string[] {
        return Array.from(this.unhealthy.keys());
    }
}
