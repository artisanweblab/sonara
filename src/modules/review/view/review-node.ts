import { FileGeneration, ReviewAtomState, ReviewLevel } from '../types';

export interface LevelFileEntry {
    path: string;
    displayPath: string;
    states: ReviewAtomState[];
    generation: FileGeneration;
}

export interface LevelNode {
    type: 'level';
    level: ReviewLevel;
    entries: LevelFileEntry[];
}

export interface FolderNode {
    type: 'folder';
    level: ReviewLevel;
    displayPath: string;
    label: string;
    depth: number;
    children: ReviewNode[];
}

export interface FileNode {
    type: 'file';
    level: ReviewLevel;
    path: string;
    displayPath: string;
    states: ReviewAtomState[];
    generation: FileGeneration;
}

export type ReviewNode = LevelNode | FolderNode | FileNode;
