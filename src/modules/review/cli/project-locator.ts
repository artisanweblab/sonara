import { existsSync } from 'fs';
import * as path from 'path';
import { reviewDirIn } from '../../../shared/sonara-paths';

export function locateProject(startPath: string): string {
    let current = path.resolve(startPath);
    for (;;) {
        if (existsSync(reviewDirIn(current))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return path.resolve(startPath);
        }
        current = parent;
    }
}
