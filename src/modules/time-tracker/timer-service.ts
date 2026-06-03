import * as path from 'path';
import * as vscode from 'vscode';
import { DayStore } from './day-store';
import { TickService } from './tick-service';
import { IdentityService } from './identity-service';
import { localDateKey, slotStartIso } from './local-time';
import { ActiveProject } from '../../shared/active-project';
import { timeTrackerDaysDir } from '../../shared/project-layout';

export type TaskExistsCheck = (slug: string) => boolean;

const ACTIVE_SLUG_STATE = 'sonara.timeTracker.activeSlug';

interface StoredActiveSlug {
    slug: string;
    projectId: string;
}

export interface StoredSlugResult {
    slug: string;
    projectId: string | null;
}

export interface TimerStateChange {
    activeSlug: string | null;
    slug: string;
    total: number;
}

export class TimerService implements vscode.Disposable {
    private dayStore: DayStore | undefined;
    private readonly tick: TickService;
    private readonly tickIntervalSec: number;
    private activeSlug: string | null = null;
    private readonly _onChange = new vscode.EventEmitter<TimerStateChange>();
    public readonly onChange = this._onChange.event;
    private taskMissingNotified = false;

    public constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly identity: IdentityService,
        private readonly activeProject: ActiveProject,
        private readonly taskExists: TaskExistsCheck,
        tickIntervalSec: number,
        flushIntervalSec: number,
    ) {
        this.tickIntervalSec = tickIntervalSec;
        this.tick = new TickService(
            tickIntervalSec,
            flushIntervalSec,
            tickAt => this.handleTick(tickAt),
            () => this.flush(),
        );
        this.context.subscriptions.push(this.tick);
        this.context.subscriptions.push(
            this.activeProject.onDidChange(async () => {
                await this.flush();
                await this.stopInternal(false);
                this.dayStore = undefined;
            }),
        );
    }

    public getActiveSlug(): string | null {
        return this.activeSlug;
    }

    public getStoredActiveSlug(): StoredSlugResult | null {
        const raw = this.context.workspaceState.get<string | StoredActiveSlug>(ACTIVE_SLUG_STATE);
        if (!raw) return null;
        // Backward-compat: old format stored a plain string without projectId.
        if (typeof raw === 'string') {
            return { slug: raw, projectId: null };
        }
        return { slug: raw.slug, projectId: raw.projectId };
    }

    private currentProjectId(): string | null {
        return this.activeProject.get()?.uri.toString() ?? null;
    }

    public async start(slug: string): Promise<void> {
        const userKey = await this.identity.resolve();
        if (!userKey) return;
        const dayStore = this.requireDayStore();
        if (!dayStore) return;

        if (this.activeSlug && this.activeSlug !== slug) {
            await this.stopInternal(false);
        }

        this.activeSlug = slug;
        this.taskMissingNotified = false;
        const projectId = this.currentProjectId();
        const storedValue: StoredActiveSlug | string = projectId
            ? { slug, projectId }
            : slug;
        await this.context.workspaceState.update(ACTIVE_SLUG_STATE, storedValue);

        const today = localDateKey(new Date());
        await dayStore.recomputeTotal(userKey, today, slug);
        await dayStore.flush();

        if (!this.tick.isRunning()) {
            this.tick.start();
        }
        const total = await this.sumTotal(userKey, slug);
        this._onChange.fire({ activeSlug: this.activeSlug, slug, total });
    }

    public async stop(): Promise<void> {
        await this.stopInternal(true);
    }

    public async toggle(slug: string): Promise<void> {
        if (this.activeSlug === slug) {
            await this.stop();
        } else {
            await this.start(slug);
        }
    }

    public async continueFromState(): Promise<void> {
        const stored = this.getStoredActiveSlug();
        if (!stored) return;
        await this.start(stored.slug);
    }

    public async clearStoredActive(): Promise<void> {
        await this.context.workspaceState.update(ACTIVE_SLUG_STATE, undefined);
        this.activeSlug = null;
    }

    public async totalForSlug(slug: string): Promise<number> {
        const userKey = this.identity.get();
        if (!userKey) return 0;
        return this.sumTotal(userKey, slug);
    }

    public async totalsBySlug(): Promise<Record<string, number>> {
        const userKey = this.identity.get();
        if (!userKey) return {};
        const dayStore = this.requireDayStore();
        if (!dayStore) return {};
        return dayStore.sumTotalsBySlug(userKey);
    }

    public async todayFilePath(): Promise<string | undefined> {
        const userKey = await this.identity.resolve();
        if (!userKey) return undefined;
        const folder = this.activeProject.get();
        if (!folder) return undefined;
        const root = timeTrackerDaysDir(folder);
        return path.join(root, userKey, `${localDateKey(new Date())}.json`);
    }

    public async flush(): Promise<void> {
        if (this.dayStore) {
            await this.dayStore.flush();
        }
    }

    private async stopInternal(emit: boolean): Promise<void> {
        const slug = this.activeSlug;
        this.activeSlug = null;
        await this.context.workspaceState.update(ACTIVE_SLUG_STATE, undefined);
        this.tick.stop();
        if (slug) {
            const userKey = this.identity.get();
            const dayStore = this.requireDayStore();
            if (userKey && dayStore) {
                const today = localDateKey(new Date());
                await dayStore.recomputeTotal(userKey, today, slug);
                await dayStore.flush();
                if (emit) {
                    const total = await this.sumTotal(userKey, slug);
                    this._onChange.fire({ activeSlug: null, slug, total });
                }
            }
        }
    }

    private async handleTick(tickAt: Date): Promise<void> {
        const slug = this.activeSlug;
        if (!slug) return;
        if (!this.taskFileExists(slug)) {
            if (!this.taskMissingNotified) {
                this.taskMissingNotified = true;
                void vscode.window.showWarningMessage(
                    `Time tracker stopped: task \`${slug}\` no longer exists.`,
                );
                await this.stop();
            }
            return;
        }
        const userKey = this.identity.get();
        const dayStore = this.requireDayStore();
        if (!userKey || !dayStore) return;
        const dateKey = localDateKey(tickAt);
        const iso = slotStartIso(tickAt);
        await dayStore.addTick(userKey, dateKey, slug, iso, this.tickIntervalSec);
        await dayStore.flush();
        const total = await this.sumTotal(userKey, slug);
        this._onChange.fire({ activeSlug: slug, slug, total });
    }

    private async sumTotal(userKey: string, slug: string): Promise<number> {
        const dayStore = this.requireDayStore();
        if (!dayStore) return 0;
        return dayStore.sumTotalsForSlug(userKey, slug);
    }

    private taskFileExists(slug: string): boolean {
        return this.taskExists(slug);
    }

    private requireDayStore(): DayStore | undefined {
        if (this.dayStore) return this.dayStore;
        const folder = this.activeProject.get();
        if (!folder) return undefined;
        this.dayStore = new DayStore(timeTrackerDaysDir(folder));
        return this.dayStore;
    }

    public dispose(): void {
        this.tick.dispose();
        if (this.dayStore) {
            // Best-effort sync flush on dispose: schedule async and ignore.
            void this.dayStore.flush();
        }
        this._onChange.dispose();
    }
}
