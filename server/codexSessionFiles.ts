import { promises as fs } from 'node:fs';
import path from 'node:path';

function isMissingTarget(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException)?.code || '');
}

/** Walk an administrator-configured session root, including storage-tier links.
 * Keep logical paths under that root: persisted detail caches validate those
 * paths against the profile home. Canonical paths are only used for cycle and
 * alias detection, never returned as replacement session locations.
 */
export async function walkJsonlFiles(rootDir: string): Promise<string[]> {
  const pending = [rootDir];
  const directories = new Set<string>();
  const targets = new Set<string>();
  const files: string[] = [];

  while (pending.length) {
    const current = pending.pop()!;
    try {
      const canonical = await fs.realpath(current);
      if (directories.has(canonical)) continue;
      directories.add(canonical);
      const entries = await fs.readdir(current, { withFileTypes: true });
      // Prefer ordinary entries over aliases when both refer to the same file.
      entries.sort((a, b) => Number(a.isSymbolicLink()) - Number(b.isSymbolicLink()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        const logicalPath = path.join(current, entry.name);
        try {
          const kind = entry.isSymbolicLink() ? await fs.stat(logicalPath) : entry;
          if (kind.isDirectory()) {
            pending.push(logicalPath);
          } else if (kind.isFile() && entry.name.endsWith('.jsonl')) {
            const target = await fs.realpath(logicalPath);
            if (!targets.has(target)) {
              targets.add(target);
              files.push(logicalPath);
            }
          }
        } catch (error) {
          // A dangling link or a concurrent archive move must not hide every
          // other session. Permission and I/O errors remain observable.
          if (!isMissingTarget(error)) throw error;
        }
      }
    } catch (error) {
      if (!isMissingTarget(error)) throw error;
    }
  }
  return files;
}
