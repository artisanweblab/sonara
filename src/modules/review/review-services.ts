import * as vscode from 'vscode';
import { isInsideFolder } from '../../shared/project-catalog';
import { SonaraProject } from '../../shared/sonara-project';
import { ReviewService } from './review-service';

export type ServiceFactory = (project: SonaraProject) => ReviewService;

interface RunningService {
    service: ReviewService;
    subscription: vscode.Disposable;
}

export class ReviewServices implements vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.emitter.event;

    private readonly running = new Map<string, RunningService>();

    constructor(private readonly create: ServiceFactory) {}

    sync(projects: readonly SonaraProject[]): void {
        const wanted = new Set(projects.map(project => project.uri.fsPath));
        for (const [key, entry] of this.running) {
            if (!wanted.has(key)) {
                this.stop(key, entry);
            }
        }
        for (const project of projects) {
            if (!this.running.has(project.uri.fsPath)) {
                const service = this.create(project);
                this.running.set(project.uri.fsPath, { service, subscription: service.onDidChange(() => this.emitter.fire()) });
            }
        }
        this.emitter.fire();
    }

    get(project: string): ReviewService | undefined {
        return this.running.get(project)?.service;
    }

    all(): ReviewService[] {
        return Array.from(this.running.values(), entry => entry.service)
            .sort((a, b) => a.project.uri.fsPath.localeCompare(b.project.uri.fsPath));
    }

    serviceForFile(fsPath: string): ReviewService | undefined {
        return this.all()
            .filter(service => isInsideFolder(fsPath, service.project.uri.fsPath))
            .sort((a, b) => b.project.uri.fsPath.length - a.project.uri.fsPath.length)[0];
    }

    private stop(key: string, entry: RunningService): void {
        entry.subscription.dispose();
        entry.service.dispose();
        this.running.delete(key);
    }

    dispose(): void {
        for (const [key, entry] of this.running) {
            this.stop(key, entry);
        }
        this.emitter.dispose();
    }
}
