import * as vscode from 'vscode';
import { TaskStore } from '../store/task-store';
import {
    NO_STATUS_SECTION_ID,
    PRIORITIES,
    PRIORITY_LABELS,
    PRIORITY_RANK,
    STATUSES,
    STATUS_LABELS,
    Task,
    TaskParseError,
    TaskPriority,
    TaskStatus,
} from '../types';
import { buildPanelHtml } from './panel-html';
import { buildTasksMarkdown, MarkdownTaskDto } from './markdown-export';
import { executeNewTask } from '../commands/new-task-command';
import { executeChangeSprint } from '../commands/change-sprint-command';
import { executeEditLabels } from '../commands/edit-labels-command';
import { executeChangeStatus } from '../commands/change-status-command';
import { executeChangePriority } from '../commands/change-priority-command';
import { TimerService } from '../../time-tracker/timer-service';
import { taskFileSlug } from '../../time-tracker/slug';

type IncomingMessage =
    | { type: 'ready' }
    | { type: 'refresh' }
    | { type: 'newTask'; status: TaskStatus | null }
    | { type: 'openPreview'; id: string }
    | { type: 'openEditor'; id: string }
    | { type: 'copyText'; id: string }
    | { type: 'copyPath'; id: string }
    | { type: 'revealInOS'; id: string }
    | { type: 'changeStatus'; id: string }
    | { type: 'changePriority'; id: string }
    | { type: 'changeSprint'; id: string }
    | { type: 'editLabels'; id: string }
    | { type: 'delete'; id: string }
    | { type: 'toggleSection'; sectionId: string; collapsed: boolean }
    | { type: 'openFilterPicker'; kind: 'priority' | 'sprint' | 'label' }
    | { type: 'toggleFilterValue'; kind: 'priority' | 'sprint' | 'label'; value: string }
    | { type: 'clearFilters' }
    | { type: 'copyAllAsMarkdown'; mode: 'summary' | 'full' }
    | { type: 'copySectionAsMarkdown'; sectionId: string; mode: 'summary' | 'full' }
    | { type: 'timerToggle'; slug: string };

type CopyMarkdownMode = 'summary' | 'full';

interface TaskFilters {
    priorities: TaskPriority[];
    sprints: string[];
    labels: string[];
}

interface TaskDto {
    id: string;
    slug: string | null;
    title: string;
    status: TaskStatus | null;
    priority: TaskPriority;
    sprint: string | null;
    labels: string[];
    created: string | null;
    updated: string | null;
    summary: string;
    body: string;
    timeTotalSec: number;
    isTimerActive: boolean;
}

interface ErrorDto {
    id: string;
    fileName: string;
    message: string;
}

interface MetaDto {
    statuses: readonly TaskStatus[];
    statusLabels: Record<TaskStatus, string>;
    priorities: readonly TaskPriority[];
    priorityLabels: Record<TaskPriority, string>;
    priorityRank: Record<TaskPriority, number>;
    noStatusSectionId: string;
    noSprintFilterValue: string;
    noSprintFilterLabel: string;
    noLabelsFilterValue: string;
    noLabelsFilterLabel: string;
}

interface StateDto {
    tasks: TaskDto[];
    errors: ErrorDto[];
    hasTasksDir: boolean;
    projectName: string;
    collapsedSections: string[];
    filters: TaskFilters;
    meta: MetaDto;
}

const COLLAPSED_SECTIONS_KEY = 'sonara.tasks.collapsedSections';
const DEFAULT_COLLAPSED_SECTIONS: readonly string[] = ['backlog', 'done', 'released', 'cancelled', NO_STATUS_SECTION_ID];
const FILTERS_KEY = 'sonara.tasks.filters';
const DEFAULT_FILTERS: TaskFilters = { priorities: [], sprints: [], labels: [] };
const NO_SPRINT_FILTER_VALUE = '__none__';
const NO_SPRINT_FILTER_LABEL = 'No sprint';
const NO_LABELS_FILTER_VALUE = '__none__';
const NO_LABELS_FILTER_LABEL = 'No labels';

export class TasksWebviewPanel implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly VIEW_ID = 'sonara.tasks';

    private view: vscode.WebviewView | undefined;
    private secondaryColumn: vscode.ViewColumn | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private timer: TimerService | undefined;
    private totalsBySlug: Record<string, number> = {};

    public constructor(
        private readonly store: TaskStore,
        private readonly extensionUri: vscode.Uri,
        private readonly memento: vscode.Memento,
    ) {
        this.disposables.push(this.store.onDidChange(() => {
            void this.refreshTotalsAndPush();
        }));
    }

    public attachTimerService(timer: TimerService): void {
        this.timer = timer;
        this.disposables.push(
            timer.onChange(change => {
                if (change.slug) {
                    this.totalsBySlug[change.slug] = change.total;
                }
                this.pushState();
            }),
        );
        void this.refreshTotalsAndPush();
    }

    private async refreshTotalsAndPush(): Promise<void> {
        if (this.timer) {
            try {
                this.totalsBySlug = await this.timer.totalsBySlug();
            } catch {
                // ignore - totals stay as last known
            }
        }
        this.pushState();
    }

    public resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        view.webview.html = buildPanelHtml();
        view.webview.onDidReceiveMessage((msg: IncomingMessage) => {
            void this.handleMessage(msg);
        });
        view.onDidChangeVisibility(() => {
            if (view.visible) {
                this.pushState();
            }
        });
        this.pushState();
    }

    private async handleMessage(msg: IncomingMessage): Promise<void> {
        switch (msg.type) {
            case 'ready':
            case 'refresh':
                await this.store.rescan();
                this.pushState();
                return;
            case 'newTask':
                await executeNewTask(this.store, msg.status ?? 'inbox');
                return;
            case 'openPreview': {
                const uri = this.store.getUriByPath(msg.id);
                if (uri) {
                    await this.openMarkdownPreviewReusing(uri);
                }
                return;
            }
            case 'openEditor': {
                const uri = this.store.getUriByPath(msg.id);
                if (uri) {
                    const column = this.resolveSecondaryColumn();
                    const document = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(document, { viewColumn: column });
                    if (column === vscode.ViewColumn.Beside) {
                        this.secondaryColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
                    }
                }
                return;
            }
            case 'copyText': {
                const task = this.store.getTaskByPath(msg.id);
                if (task) {
                    await vscode.env.clipboard.writeText(task.body);
                    this.postCopied(msg.id, 'text');
                }
                return;
            }
            case 'copyPath': {
                const uri = this.store.getUriByPath(msg.id);
                if (uri) {
                    await vscode.env.clipboard.writeText(uri.fsPath);
                    this.postCopied(msg.id, 'path');
                }
                return;
            }
            case 'revealInOS': {
                const uri = this.store.getUriByPath(msg.id);
                if (uri) {
                    await vscode.commands.executeCommand('revealFileInOS', uri);
                }
                return;
            }
            case 'changeStatus':
                await executeChangeStatus(this.store, msg.id);
                return;
            case 'changePriority':
                await executeChangePriority(this.store, msg.id);
                return;
            case 'changeSprint':
                await executeChangeSprint(this.store, msg.id);
                return;
            case 'editLabels':
                await executeEditLabels(this.store, msg.id);
                return;
            case 'delete':
                await this.handleDelete(msg.id);
                return;
            case 'toggleSection':
                await this.handleToggleSection(msg.sectionId, msg.collapsed);
                return;
            case 'openFilterPicker':
                await this.handleOpenFilterPicker(msg.kind);
                return;
            case 'toggleFilterValue':
                await this.handleToggleFilterValue(msg.kind, msg.value);
                return;
            case 'clearFilters':
                await this.memento.update(FILTERS_KEY, DEFAULT_FILTERS);
                this.pushState();
                return;
            case 'copyAllAsMarkdown':
                await this.handleCopyMarkdown(null, msg.mode);
                return;
            case 'copySectionAsMarkdown':
                await this.handleCopyMarkdown(msg.sectionId, msg.mode);
                return;
            case 'timerToggle':
                if (this.timer && msg.slug) {
                    await this.timer.toggle(msg.slug);
                }
                return;
        }
    }

    private async handleCopyMarkdown(sectionId: string | null, mode: CopyMarkdownMode): Promise<void> {
        const allTasks = this.collectTaskDtos();
        const filtered = this.applyFilters(allTasks, this.getSanitizedFilters());
        const meta = {
            statuses: STATUSES,
            statusLabels: STATUS_LABELS,
            priorityLabels: PRIORITY_LABELS,
            priorityRank: PRIORITY_RANK,
        };
        const onlyStatus: TaskStatus | null | undefined =
            sectionId === null ? undefined : sectionId === NO_STATUS_SECTION_ID ? null : (sectionId as TaskStatus);

        const enriched = await this.loadRawContents(filtered);
        const markdown =
            onlyStatus === undefined
                ? buildTasksMarkdown(enriched, meta, { mode })
                : buildTasksMarkdown(enriched, meta, { mode, onlyStatus });

        await vscode.env.clipboard.writeText(markdown);

        if (sectionId === null) {
            this.view?.webview.postMessage({ type: 'copiedMarkdown', scope: 'all', mode });
        } else {
            this.view?.webview.postMessage({ type: 'copiedMarkdown', scope: 'section', mode, sectionId });
        }
    }

    private async loadRawContents(tasks: readonly MarkdownTaskDto[]): Promise<MarkdownTaskDto[]> {
        const reads = tasks.map(async (t): Promise<MarkdownTaskDto> => {
            const uri = this.store.getUriByPath(t.id);
            if (!uri) return t;
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                return { ...t, rawContent: new TextDecoder('utf-8').decode(bytes) };
            } catch {
                return t;
            }
        });
        return Promise.all(reads);
    }

    private collectTaskDtos(): MarkdownTaskDto[] {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        const result: MarkdownTaskDto[] = [];
        for (const entry of this.store.getEntries()) {
            if (entry.kind !== 'task') continue;
            const t = entry.task;
            result.push({
                id: t.fileUri.fsPath,
                title: t.title,
                status: t.status,
                priority: t.priority,
                sprint: t.sprint,
                labels: t.labels,
                summary: t.summary,
                relativePath: toRelativePath(t.fileUri.fsPath, workspaceRoot),
                rawContent: null,
            });
        }
        return result;
    }

    private applyFilters(tasks: MarkdownTaskDto[], filters: TaskFilters): MarkdownTaskDto[] {
        const hasP = filters.priorities.length > 0;
        const hasS = filters.sprints.length > 0;
        const hasL = filters.labels.length > 0;
        if (!hasP && !hasS && !hasL) return tasks;
        const sprintAcceptsNone = filters.sprints.includes(NO_SPRINT_FILTER_VALUE);
        const labelsAcceptsNone = filters.labels.includes(NO_LABELS_FILTER_VALUE);
        return tasks.filter(t => {
            if (hasP && !filters.priorities.includes(t.priority)) return false;
            if (hasS) {
                if (t.sprint) {
                    if (!filters.sprints.includes(t.sprint)) return false;
                } else {
                    if (!sprintAcceptsNone) return false;
                }
            }
            if (hasL) {
                const isEmpty = !t.labels || t.labels.length === 0;
                if (isEmpty) {
                    if (!labelsAcceptsNone) return false;
                } else {
                    if (!t.labels.some(l => filters.labels.includes(l))) return false;
                }
            }
            return true;
        });
    }

    private async handleOpenFilterPicker(kind: 'priority' | 'sprint' | 'label'): Promise<void> {
        const current = this.getFilters();
        const otherFilters: TaskFilters = {
            priorities: kind === 'priority' ? [] : current.priorities,
            sprints: kind === 'sprint' ? [] : current.sprints,
            labels: kind === 'label' ? [] : current.labels,
        };
        const candidatePool = this.applyFilters(this.collectTaskDtos(), otherFilters);
        const countFor = (predicate: (t: MarkdownTaskDto) => boolean): number =>
            candidatePool.reduce((n, t) => n + (predicate(t) ? 1 : 0), 0);

        let items: vscode.QuickPickItem[];
        let title: string;
        let selectedValues: string[];
        let allValues: string[];
        if (kind === 'priority') {
            allValues = [...PRIORITIES];
            selectedValues = current.priorities;
            title = 'Filter by Priority';
            items = allValues.map(v => {
                const count = countFor(t => t.priority === v);
                return {
                    label: `${PRIORITY_LABELS[v as TaskPriority]} (${count})`,
                    description: v,
                    picked: selectedValues.includes(v),
                };
            });
        } else if (kind === 'sprint') {
            allValues = [NO_SPRINT_FILTER_VALUE, ...this.getAvailableSprints()];
            selectedValues = current.sprints;
            title = 'Filter by Sprint';
            const noneCount = countFor(t => !t.sprint);
            items = allValues.map(v => {
                if (v === NO_SPRINT_FILTER_VALUE) {
                    return {
                        label: `${NO_SPRINT_FILTER_LABEL} (${noneCount})`,
                        description: v,
                        picked: selectedValues.includes(v),
                    };
                }
                const count = countFor(t => t.sprint === v);
                return { label: `${v} (${count})`, description: v, picked: selectedValues.includes(v) };
            });
        } else {
            allValues = [NO_LABELS_FILTER_VALUE, ...this.getAvailableLabels()];
            selectedValues = current.labels;
            title = 'Filter by Labels';
            const noneCount = countFor(t => !Array.isArray(t.labels) || t.labels.length === 0);
            items = allValues.map(v => {
                if (v === NO_LABELS_FILTER_VALUE) {
                    return {
                        label: `${NO_LABELS_FILTER_LABEL} (${noneCount})`,
                        description: v,
                        picked: selectedValues.includes(v),
                    };
                }
                const count = countFor(t => Array.isArray(t.labels) && t.labels.includes(v));
                return { label: `${v} (${count})`, description: v, picked: selectedValues.includes(v) };
            });
        }
        if (items.length === 0) {
            await vscode.window.showInformationMessage(`No ${kind} values available.`);
            return;
        }
        const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title });
        if (!picked) return;
        const pickedValues = picked.map(it => it.description as string);
        const next: TaskFilters = { ...current };
        if (kind === 'priority') next.priorities = pickedValues as TaskPriority[];
        else if (kind === 'sprint') next.sprints = pickedValues;
        else next.labels = pickedValues;
        await this.memento.update(FILTERS_KEY, next);
        this.pushState();
    }

    private async handleToggleFilterValue(kind: 'priority' | 'sprint' | 'label', value: string): Promise<void> {
        const current = this.getFilters();
        const next: TaskFilters = {
            priorities: [...current.priorities],
            sprints: [...current.sprints],
            labels: [...current.labels],
        };
        if (kind === 'priority') {
            next.priorities = next.priorities.filter(v => v !== value);
        } else if (kind === 'sprint') {
            next.sprints = next.sprints.filter(v => v !== value);
        } else {
            next.labels = next.labels.filter(v => v !== value);
        }
        await this.memento.update(FILTERS_KEY, next);
        this.pushState();
    }

    private getFilters(): TaskFilters {
        const stored = this.memento.get<TaskFilters>(FILTERS_KEY);
        if (!stored) return { priorities: [], sprints: [], labels: [] };
        return {
            priorities: stored.priorities ?? [],
            sprints: stored.sprints ?? [],
            labels: stored.labels ?? [],
        };
    }

    private getSanitizedFilters(): TaskFilters {
        const current = this.getFilters();
        const availableSprints = new Set(this.getAvailableSprints());
        const availableLabels = new Set(this.getAvailableLabels());
        const sanitized: TaskFilters = {
            priorities: current.priorities,
            sprints: current.sprints.filter(v => v === NO_SPRINT_FILTER_VALUE || availableSprints.has(v)),
            labels: current.labels.filter(v => v === NO_LABELS_FILTER_VALUE || availableLabels.has(v)),
        };
        if (sanitized.sprints.length !== current.sprints.length || sanitized.labels.length !== current.labels.length) {
            void this.memento.update(FILTERS_KEY, sanitized);
        }
        return sanitized;
    }

    private getAvailableSprints(): string[] {
        const set = new Set<string>();
        for (const entry of this.store.getEntries()) {
            if (entry.kind === 'task' && entry.task.sprint) set.add(entry.task.sprint);
        }
        return Array.from(set).sort();
    }

    private getAvailableLabels(): string[] {
        const set = new Set<string>();
        for (const entry of this.store.getEntries()) {
            if (entry.kind === 'task') {
                for (const l of entry.task.labels) set.add(l);
            }
        }
        return Array.from(set).sort();
    }

    private async handleToggleSection(sectionId: string, collapsed: boolean): Promise<void> {
        const current = this.getCollapsedSections();
        const next = new Set(current);
        if (collapsed) {
            next.add(sectionId);
        } else {
            next.delete(sectionId);
        }
        await this.memento.update(COLLAPSED_SECTIONS_KEY, Array.from(next));
    }

    private getCollapsedSections(): string[] {
        return this.memento.get<string[]>(COLLAPSED_SECTIONS_KEY) ?? Array.from(DEFAULT_COLLAPSED_SECTIONS);
    }

    private async handleDelete(id: string): Promise<void> {
        const uri = this.store.getUriByPath(id);
        if (!uri) return;
        const task = this.store.getTaskByPath(id);
        const label = task ? task.title : this.store.getErrorByPath(id)?.fileName ?? id;
        const choice = await vscode.window.showWarningMessage(
            `Delete task "${label}"? This cannot be undone from the plugin.`,
            { modal: true },
            'Delete',
        );
        if (choice !== 'Delete') return;
        await vscode.workspace.fs.delete(uri, { useTrash: true });
    }

    private postCopied(id: string, kind: 'text' | 'path'): void {
        this.view?.webview.postMessage({ type: 'copied', id, kind });
    }

    private pushState(): void {
        if (!this.view) return;
        this.view.webview.postMessage({ type: 'state', state: this.buildState() });
    }

    private buildState(): StateDto {
        const tasks: TaskDto[] = [];
        const errors: ErrorDto[] = [];
        const activeSlug = this.timer?.getActiveSlug() ?? null;
        for (const entry of this.store.getEntries()) {
            if (entry.kind === 'task') {
                const slug = taskFileSlug(entry.task.fileUri.fsPath);
                const total = slug ? this.totalsBySlug[slug] ?? 0 : 0;
                const isActive = slug !== null && slug === activeSlug;
                tasks.push(taskToDto(entry.task, slug, total, isActive));
            } else {
                errors.push(errorToDto(entry.error));
            }
        }
        return {
            tasks,
            errors,
            hasTasksDir: this.store.hasTasksDir(),
            projectName: vscode.workspace.workspaceFolders?.[0]?.name ?? '',
            collapsedSections: this.getCollapsedSections(),
            filters: this.getSanitizedFilters(),
            meta: {
                statuses: STATUSES,
                statusLabels: STATUS_LABELS,
                priorities: PRIORITIES,
                priorityLabels: PRIORITY_LABELS,
                priorityRank: PRIORITY_RANK,
                noStatusSectionId: NO_STATUS_SECTION_ID,
                noSprintFilterValue: NO_SPRINT_FILTER_VALUE,
                noSprintFilterLabel: NO_SPRINT_FILTER_LABEL,
                noLabelsFilterValue: NO_LABELS_FILTER_VALUE,
                noLabelsFilterLabel: NO_LABELS_FILTER_LABEL,
            },
        };
    }

    private resolveSecondaryColumn(): vscode.ViewColumn {
        if (this.secondaryColumn !== undefined) {
            const stillOpen = vscode.window.tabGroups.all.some(
                g => g.viewColumn === this.secondaryColumn && g.tabs.length > 0,
            );
            if (stillOpen) {
                return this.secondaryColumn;
            }
            this.secondaryColumn = undefined;
        }
        return vscode.ViewColumn.Beside;
    }

    private async openMarkdownPreviewReusing(uri: vscode.Uri): Promise<void> {
        const column = this.resolveSecondaryColumn();
        await vscode.commands.executeCommand('vscode.openWith', uri, 'vscode.markdown.preview.editor', column);
        if (column === vscode.ViewColumn.Beside) {
            this.secondaryColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
        }
    }

    public dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

function taskToDto(task: Task, slug: string | null, timeTotalSec: number, isTimerActive: boolean): TaskDto {
    return {
        id: task.fileUri.fsPath,
        slug,
        title: task.title,
        status: task.status,
        priority: task.priority,
        sprint: task.sprint,
        labels: task.labels,
        created: task.created,
        updated: task.updated,
        summary: task.summary,
        body: task.body,
        timeTotalSec,
        isTimerActive,
    };
}

function toRelativePath(fsPath: string, workspaceRoot: vscode.Uri | undefined): string {
    let rel = fsPath;
    if (workspaceRoot) {
        const rootPath = workspaceRoot.fsPath;
        if (fsPath.startsWith(rootPath)) {
            rel = fsPath.substring(rootPath.length);
            if (rel.startsWith('/') || rel.startsWith('\\')) {
                rel = rel.substring(1);
            }
        }
    }
    return rel.replace(/\\/g, '/');
}

function errorToDto(error: TaskParseError): ErrorDto {
    return {
        id: error.fileUri.fsPath,
        fileName: error.fileName,
        message: error.message,
    };
}
