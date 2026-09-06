import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface SessionCompletion {
  completedAt: number;
  startedAt: number;
}

export function latestCompletionTimes(items: readonly {
  sessionId: string | null;
  status: string;
  completedAt: string | null;
  startedAt?: string | null;
  lastRunAt?: string | null;
  lastRunStatus?: string | null;
}[]): Record<string, SessionCompletion> {
  const result: Record<string, SessionCompletion> = Object.create(null);
  for (const item of items) {
    if (!item.sessionId || (item.status !== 'completed' && item.lastRunStatus !== 'completed')) continue;
    const timestamp = Date.parse(item.completedAt || item.lastRunAt || '');
    if (Number.isFinite(timestamp) && timestamp > (result[item.sessionId]?.completedAt || 0)) {
      const startedAt = Date.parse(item.startedAt || item.lastRunAt || '');
      // A recurring item can already be running again while retaining its last
      // successful completion. Never associate that result with a future start.
      result[item.sessionId] = { completedAt: timestamp, startedAt: Number.isFinite(startedAt) ? Math.min(startedAt, timestamp) : timestamp };
    }
  }
  return result;
}

/** Read receipts belong to the authenticated viewer, not to a browser tab or
 * provider account. Only the observed completion is acknowledged, so a stale
 * tab cannot clear a newer completion. */
export class SessionReadReceiptStore {
  private loaded: Promise<void> | null = null;
  private receipts: Record<string, number> = Object.create(null);
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async load(): Promise<void> {
    this.loaded ||= (async () => {
      try {
        const payload = JSON.parse(await fs.readFile(this.file, 'utf8'));
        for (const [key, value] of Object.entries(payload.receipts || {})) {
          if (typeof value === 'number' && Number.isFinite(value) && value > 0) this.receipts[key] = value;
        }
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
      }
    })();
    return this.loaded;
  }

  async read(owner: string, profileId: string): Promise<Record<string, number>> {
    await this.load();
    const result: Record<string, number> = Object.create(null);
    for (const [key, value] of Object.entries(this.receipts)) {
      const [storedOwner, storedProfile, sessionId] = JSON.parse(key);
      if (storedOwner === owner && storedProfile === profileId) result[sessionId] = value;
    }
    return result;
  }

  async markViewed(owner: string, profileId: string, sessionId: string, completedAt: number): Promise<number> {
    await this.load();
    const key = JSON.stringify([owner, profileId, sessionId]);
    const previous = this.receipts[key] || 0;
    if (completedAt <= previous) {
      await this.writes;
      return previous;
    }
    this.receipts[key] = completedAt;
    const snapshot = JSON.stringify({ version: 1, receipts: this.receipts });
    this.writes = this.writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
    try {
      await this.writes;
    } catch (error) {
      // Permit a retry after a failed write instead of acknowledging memory only.
      if (this.receipts[key] === completedAt) this.receipts[key] = previous;
      throw error;
    }
    return this.receipts[key];
  }
}
