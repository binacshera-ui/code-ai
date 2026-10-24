import { promises as fs } from 'node:fs';
import path from 'node:path';
import { walkJsonlFiles } from './codexSessionFiles.js';
import { codexNativeTurnFailure } from './codexNativeTurnOutcome.mjs';
import { failureKindLabel } from '../shared/codexRunOutcome.js';

interface FileCursor { offset: number; dev: number; ino: number; skipLine: boolean; notBefore: string; }
export interface NativeFailureCursor { version: 1; startedAt: string; observedAt: string; files: Record<string, FileCursor>; }
export interface NativeFailureObservation { profileId: string; sessionId: string; turnId: string; timestamp: string; reason: string; }
export interface NativeFailureBatch { cursor: NativeFailureCursor; failures: NativeFailureObservation[]; }
type Profile = { id: string; codexHome: string };
const READ_BYTES = 256 * 1024;

/** Read-only tailing of native rollouts, consumed by the EXISTING outbox worker.
 * No native connection, agent, model request, new timer, or transcript write.
 * Cursor stores byte positions only, never command/user/assistant text.
 */
export async function readCodexNativeFailures(profiles: readonly Profile[], previous: unknown): Promise<NativeFailureBatch> {
  const raw = previous as NativeFailureCursor | null;
  const initialized = raw?.version === 1 && Number.isFinite(Date.parse(raw.startedAt)) && raw.files && typeof raw.files === 'object';
  const now = new Date().toISOString();
  const cursor: NativeFailureCursor = { version: 1, startedAt: initialized ? raw.startedAt : now, observedAt: now, files: {} };
  const failures: NativeFailureObservation[] = [];
  let budget = 4 * 1024 * 1024;
  for (const profile of profiles) {
    for (const file of await walkJsonlFiles(path.join(profile.codexHome, 'sessions'))) {
      const key = JSON.stringify([profile.id, path.relative(profile.codexHome, file)]);
      let stat;
      try { stat = await fs.stat(file); } catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
      const old = initialized ? raw.files[key] : null;
      const valid = old && Number.isSafeInteger(old.offset) && old.offset >= 0 && old.offset <= stat.size
        && old.dev === stat.dev && old.ino === stat.ino;
      const position: FileCursor = valid ? { ...old } : { offset: initialized ? 0 : stat.size, dev: stat.dev, ino: stat.ino,
        skipLine: false, notBefore: initialized ? raw.observedAt || raw.startedAt : now };
      cursor.files[key] = position;
      if (position.offset >= stat.size || budget <= 0) continue;
      const handle = await fs.open(file, 'r');
      try {
        // Root session identity comes from native metadata, not model text or
        // a guessed active queue row. Child agents don't generate phone spam.
        const head = Buffer.alloc(Math.min(READ_BYTES, stat.size));
        await handle.read(head, 0, head.length, 0);
        const end = head.indexOf(10);
        if (end < 0) continue;
        let meta;
        try { meta = JSON.parse(head.subarray(0, end).toString('utf8')); } catch { continue; }
        const sessionId = meta?.type === 'session_meta' && typeof meta.payload?.id === 'string' ? meta.payload.id : null;
        if (!sessionId || !/^[a-zA-Z0-9._:-]{1,240}$/.test(sessionId) || meta.payload?.source?.subagent) {
          position.offset = stat.size; continue;
        }
        const bytes = Math.min(READ_BYTES, stat.size - position.offset, budget);
        const chunk = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(chunk, 0, bytes, position.offset);
        budget -= bytesRead;
        let start = 0;
        let last = 0;
        for (let i = 0; i < bytesRead; i++) {
          if (chunk[i] !== 10) continue;
          if (position.skipLine) position.skipLine = false;
          else if (i - start <= 64 * 1024) {
            let row;
            try { row = JSON.parse(chunk.subarray(start, i).toString('utf8')); } catch { /* Non-JSON or oversize native tool row. */ }
            const payload = row?.type === 'event_msg' ? row.payload : null;
            const error = payload?.type === 'task_complete' ? payload.error : null;
            const turnId = payload?.turn_id;
            const timestamp = row?.timestamp;
            if (error && typeof turnId === 'string' && /^[a-zA-Z0-9._:-]{1,240}$/.test(turnId)
                && typeof timestamp === 'string' && Date.parse(timestamp) >= Date.parse(position.notBefore || cursor.startedAt)) {
              const kind = codexNativeTurnFailure(typeof error === 'string' ? { message: error } : error).kind;
              failures.push({ profileId: profile.id, sessionId, turnId, timestamp, reason: failureKindLabel(kind) });
            }
          }
          start = last = i + 1;
        }
        position.offset += last;
        // Never persist unfinished payload text. If a line exceeds the read
        // budget, skip its remainder; terminal metadata is bounded and small.
        if (last === 0 && bytesRead === READ_BYTES) { position.offset += bytesRead; position.skipLine = true; }
      } finally { await handle.close(); }
    }
  }
  return { cursor, failures };
}
