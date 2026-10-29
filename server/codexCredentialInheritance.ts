import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Derived homes follow explicit source login/logout without keeping stale auth. */
export async function syncCodexAccountFiles(sourceHome: string, targetHome: string): Promise<void> {
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return;
  await fs.mkdir(targetHome, { recursive: true, mode: 0o700 });
  for (const name of ['auth.json', 'code-ai-api-connection.json']) {
    const source = path.join(sourceHome, name), target = path.join(targetHome, name);
    try {
      await fs.copyFile(source, target);
      await fs.chmod(target, 0o600);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error('לא ניתן לעדכן את חיבור פרופיל Codex הנגזר.');
      await fs.rm(target, { force: true });
    }
  }
}
