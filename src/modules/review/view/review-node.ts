import { FileGeneration, ReviewAtomState, ReviewLevel } from '../types';

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
    level: ReviewLevel;
    entries: LevelFileEntry[];
}

export interface FolderNode {
    type: 'folder';
    project: string;
    level: ReviewLevel;
    displayPath: string;
    label: string;
    depth: number;
    children: ReviewNode[];
}

export interface FileNode {
    type: 'file';
    project: string;
    level: ReviewLevel;
    path: string;
    displayPath: string;
    states: ReviewAtomState[];
    generation: FileGeneration;
    status: string;
}

export type LevelContentNode = LevelNode | FolderNode | FileNode;

export type ReviewNode = RepositoryNode | LevelContentNode;
