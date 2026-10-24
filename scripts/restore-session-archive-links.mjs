import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Repair only missing logical aliases. Never move, copy, replace or write a
// rollout/database. Every target must belong to the selected profile's index.
export async function restoreArchiveLinks({ codexHome, archiveRoot, apply = false }) {
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'), { readOnly: true });
  let ids;
  try { ids = new Set(db.prepare('SELECT id FROM threads').all().map(row => row.id)); }
  finally { db.close(); }
  const results = [];
  const pending = [archiveRoot];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) { pending.push(target); continue; }
      if (!entry.isFile()) continue;
      const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T.+-([a-f0-9-]{36})\.jsonl$/i.exec(entry.name);
      if (!match || !ids.has(match[4])) continue;
      const input = createReadStream(target);
      const lines = createInterface({ input, crlfDelay: Infinity });
      let first;
      try { for await (const line of lines) { first = JSON.parse(line); break; } }
      finally { lines.close(); input.destroy(); }
      if (first?.type !== 'session_meta' || first.payload?.id !== match[4]) throw new Error(`archive_metadata_mismatch:${entry.name}`);
      const logical = path.join(codexHome, 'sessions', match[1], match[2], match[3], entry.name);
      try { await fs.lstat(logical); continue; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const result = { id: match[4], logical, target, state: 'missing' };
      if (apply) {
        await fs.mkdir(path.dirname(logical), { recursive: true });
        try { await fs.symlink(target, logical, 'file'); result.state = 'restored'; }
        catch (error) { if (error.code !== 'EEXIST') throw error; result.state = 'concurrently-restored'; }
      }
      results.push(result);
    }
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3 || args[2] && args[2] !== '--apply'
    || !args.slice(0, 2).every(arg => path.isAbsolute(arg))) {
    throw new Error('Usage: node restore-session-archive-links.mjs ABSOLUTE_CODEX_HOME ABSOLUTE_ARCHIVE_ROOT [--apply]');
  }
  const results = await restoreArchiveLinks({ codexHome: args[0], archiveRoot: args[1], apply: args[2] === '--apply' });
  console.log(JSON.stringify({ apply: args[2] === '--apply', count: results.length, results }, null, 2));
}
