import { FileGeneration, ReviewAtomState, ShownLevel } from '../types';

export interface LevelFileEntry {
    path: string;
    displayPath: string;
    states: ReviewAtomState[];
    generation: FileGeneration;
    status: string;
}

export interface RepositoryNode {
    type: 'repository';
    project: string;
}

export interface LevelNode {
    type: 'level';
    project: string;
    level: ShownLevel;
    entries: LevelFileEntry[];
}

export interface FolderNode {
    type: 'folder';
    project: string;
    level: ShownLevel;
    displayPath: string;
    label: string;
    depth: number;
    children: ReviewNode[];
}

export interface FileNode {
    type: 'file';
    project: string;
    level: ShownLevel;
    path: string;
    displayPath: string;
    states: ReviewAtomState[];
    generation: FileGeneration;
    status: string;
}

export type LevelContentNode = LevelNode | FolderNode | FileNode;

export type ReviewNode = RepositoryNode | LevelContentNode;
