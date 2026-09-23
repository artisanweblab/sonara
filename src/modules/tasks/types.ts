import * as vscode from 'vscode';

export const STATUSES = ['activity', 'inbox', 'backlog', 'todo', 'in-progress', 'review', 'done', 'released', 'cancelled'] as const;
export type TaskStatus = (typeof STATUSES)[number];

export const PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest'] as const;
export type TaskPriority = (typeof PRIORITIES)[number];

export const STATUS_LABELS: Record<TaskStatus, string> = {
    'activity': 'Activity',
    'inbox': 'Inbox',
    'backlog': 'Backlog',
    'todo': 'To Do',
    'in-progress': 'In Progress',
    'review': 'Ready for Review',
    'done': 'Done',
    'released': 'Released',
    'cancelled': 'Cancelled',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
    'highest': 'Highest',
    'high': 'High',
    'medium': 'Medium',
    'low': 'Low',
    'lowest': 'Lowest',
};

export const PRIORITY_RANK: Record<TaskPriority, number> = {
    'highest': 0,
    'high': 1,
    'medium': 2,
    'low': 3,
    'lowest': 4,
};

export const NO_STATUS_SECTION_ID = 'no-status';

export interface Task {
    fileUri: vscode.Uri;
    title: string;
    status: TaskStatus | null;
    priority: TaskPriority;
    sprint: string | null;
    labels: string[];
    created: string | null;
    summary: string;
    body: string;
}

export interface TaskParseError {
    fileUri: vscode.Uri;
    fileName: string;
    message: string;
}

export type TaskEntry =
    | { kind: 'task'; task: Task }
    | { kind: 'error'; error: TaskParseError };
