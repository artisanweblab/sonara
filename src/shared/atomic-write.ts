import * as fs from 'fs/promises';
import * as path from 'path';

export async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath);
    const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);

    const handle = await fs.open(tmpPath, 'w');
    try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    await fs.rename(tmpPath, targetPath);
}
