#!/usr/bin/env node
/** Incremental, local-only subscription calibration. Never starts a model. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { allocation, buildReport, consumeRow, COUNTERS, initialCursor, renderMarkdown, sameQuotaEpoch, weeklyQuota } from './subscription-meter/core.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
const SCAN_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const SAMPLER_VERSION = 2;

export function validateConfig(c) {
  if (!c || !/^[a-zA-Z0-9_-]+$/.test(c.profileId || '') || !path.isAbsolute(c.codexHome || '')
      || !path.isAbsolute(c.stateDir || '')) throw new Error('Invalid profileId, codexHome or stateDir');
  if (path.resolve(c.stateDir).startsWith(path.resolve(c.codexHome) + path.sep)
      || path.resolve(c.stateDir) === path.resolve(c.codexHome)) throw new Error('State must be outside provider home');
  allocation(c);
  if (c.minimumQuotaDelta != null && (!Number.isFinite(c.minimumQuotaDelta) || c.minimumQuotaDelta < 5)) throw new Error('minimumQuotaDelta must be >=5');
  if (c.minimumSegmentSeconds != null && (!Number.isFinite(c.minimumSegmentSeconds) || c.minimumSegmentSeconds < 300)) throw new Error('minimumSegmentSeconds must be >=300');
  return c;
}

export function openStore(c) {
  fs.mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(c.stateDir, 'measurements.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY, started_at TEXT NOT NULL, config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS current_campaign(id INTEGER PRIMARY KEY CHECK(id=1), campaign TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cursors(thread_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(campaign TEXT NOT NULL, thread_id TEXT NOT NULL, byte_offset INTEGER NOT NULL,
      timestamp TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(campaign,thread_id,byte_offset));
    CREATE INDEX IF NOT EXISTS event_campaign ON events(campaign,timestamp);
    CREATE TABLE IF NOT EXISTS snapshots(id INTEGER PRIMARY KEY, campaign TEXT NOT NULL, timestamp TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS snapshot_campaign ON snapshots(campaign,timestamp);
    CREATE TABLE IF NOT EXISTS gaps(id INTEGER PRIMARY KEY, campaign TEXT NOT NULL, timestamp TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS gap_campaign ON gaps(campaign,timestamp);
    CREATE TABLE IF NOT EXISTS model_totals(campaign TEXT NOT NULL, model_key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(campaign,model_key));
    CREATE TABLE IF NOT EXISTS segments(campaign TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(campaign,start,end));
    CREATE TABLE IF NOT EXISTS anchors(campaign TEXT PRIMARY KEY, body TEXT NOT NULL);`);
  fs.chmodSync(path.join(c.stateDir, 'measurements.sqlite'), 0o600);
  return db;
}

export function campaign(db) {
  const row = db.prepare('SELECT c.* FROM campaigns c JOIN current_campaign a ON a.campaign=c.id WHERE a.id=1').get();
  return row ? { ...row, config: JSON.parse(row.config) } : null;
}

export function begin(db, config) {
  const id = randomUUID(), startedAt = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO campaigns VALUES(?,?,?)').run(id, startedAt, JSON.stringify(config));
    db.prepare('INSERT INTO current_campaign VALUES(1,?) ON CONFLICT(id) DO UPDATE SET campaign=excluded.campaign').run(id);
    // A new measurement must not inherit uncollected usage from the previous one.
    db.exec('DELETE FROM cursors');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { id, startedAt };
}

export async function readQuota(c, fetchImpl = fetch) {
  let auth;
  try { auth = JSON.parse(fs.readFileSync(path.join(c.codexHome, 'auth.json'), 'utf8')); }
  catch { return { timestamp: new Date().toISOString(), quota: null, error: 'auth-unavailable' }; }
  const token = auth?.tokens?.access_token, accountId = auth?.tokens?.account_id;
  if (typeof token !== 'string' || typeof accountId !== 'string') return { timestamp: new Date().toISOString(), quota: null, error: 'subscription-auth-unavailable' };
  const accountKey = createHash('sha256').update(accountId).digest('hex').slice(0,24);
  try {
    const r = await fetchImpl('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET', headers: { Authorization: `Bearer ${token}`, 'ChatGPT-Account-ID': accountId, 'OpenAI-Beta': 'codex-1' },
      signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!r.ok) return { accountKey, timestamp: new Date().toISOString(), quota: null, error: `quota-http-${r.status}` };
    const payload = await r.json(), quota = weeklyQuota(payload);
    return { accountKey, timestamp: new Date().toISOString(), quota,
      error: quota ? null : 'weekly-quota-unavailable', source: 'chatgpt-wham' };
  } catch { return { accountKey, timestamp: new Date().toISOString(), quota: null, error: 'quota-request-failed' }; }
}

/** Canonical native index only: bounded query, no history-directory crawl. */
export function discover(c, sinceSeconds) {
  const db = new DatabaseSync(path.join(c.codexHome, 'state_5.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=2000');
    const rows = db.prepare(`SELECT id,rollout_path,created_at,created_at_ms,model,reasoning_effort
      FROM threads WHERE updated_at>=? ORDER BY updated_at DESC LIMIT 2001`).all(sinceSeconds);
    if (rows.length > 2000) throw new Error('thread-discovery-overflow');
    return rows;
  } finally { db.close(); }
}

/** Identify only envelopes the accounting consumer already ignores. The JSON
 * header is parsed, not searched inside message content. Never buffer huge
 * response/tool payloads simply to throw them away after JSON.parse. */
function irrelevantEnvelope(prefix) {
  const text = prefix.toString('utf8');
  const marker = /,\s*"payload"\s*:/.exec(text);
  if (!marker) return false;
  try {
    const header = JSON.parse(text.slice(0,marker.index)+'}');
    if (typeof header.type !== 'string') return false;
    if (!['event_msg','turn_context','token_usage_record'].includes(header.type)) return true;
    if (header.type !== 'event_msg') return false;
    const kind = /^\s*\{\s*"type"\s*:\s*("(?:[^"\\]|\\.)*")\s*[,}]/.exec(text.slice(marker.index+marker[0].length));
    return Boolean(kind && !['token_count','thread_settings_applied','model_reroute','token_usage_record'].includes(JSON.parse(kind[1])));
  } catch { return false; }
}

/** Incremental framing across bounded chunks and samples. A continuation stores
 * offsets/classification only, never conversation text. No EOF jumps on limits. */
export function readRows(filename, start, { tail = false, readerState = null, maxBytes = SCAN_BYTES } = {}) {
  const fd = fs.openSync(filename, 'r');
  try {
    const st = fs.fstatSync(fd);
    let position = readerState?.position ?? (tail ? Math.max(0,st.size-MAX_BYTES) : start);
    let lineStart = readerState?.lineStart ?? position;
    let discard = readerState?.discard || null;
    let gap = null, invalidRows = 0, skippedIrrelevantLines = 0;
    if (!readerState && position > 0) {
      const previous = Buffer.alloc(1); fs.readSync(fd,previous,0,1,position-1);
      if (previous[0] !== 10) {
        discard = tail ? 'bootstrap-prefix' : 'unverified-prefix';
        if (!tail) gap = 'old-reader-midline-resume';
      }
    }
    const endPosition = Math.min(st.size,position+maxBytes), rows = [];
    let pieces = [], length = 0;
    while (position < endPosition) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES,endPosition-position));
      const read = fs.readSync(fd,chunk,0,chunk.length,position);
      if (!read) break;
      let partStart = 0;
      while (partStart < read) {
        const newline = chunk.indexOf(10,partStart);
        const end = newline < 0 || newline >= read ? read : newline;
        const part = chunk.subarray(partStart,end);
        if (!discard) {
          pieces.push(part); length += part.length;
          if (length > 16384 && irrelevantEnvelope(Buffer.concat(pieces,Math.min(length,8192)))) {
            discard = 'irrelevant'; pieces = []; length = 0;
          } else if (length > MAX_BYTES) {
            discard = 'oversize-telemetry'; pieces = []; length = 0; gap = 'oversize-telemetry-row';
          }
        }
        if (end < read) {
          if (discard === 'irrelevant') skippedIrrelevantLines++;
          else if (!discard && length) {
            const bytes = Buffer.concat(pieces,length);
            if (irrelevantEnvelope(bytes.subarray(0,8192))) skippedIrrelevantLines++;
            else try { rows.push({row:JSON.parse(bytes.toString('utf8')),offset:lineStart}); } catch { invalidRows++; }
          }
          lineStart = position+end+1; pieces = []; length = 0; discard = null;
          partStart = end+1;
        } else partStart = read;
      }
      position += read;
    }
    // Small unfinished telemetry rows restart at their first byte next sample.
    // Large discarded payloads continue from the scanned position, avoiding an
    // unbounded buffer and an endless reread of the same first four megabytes.
    const unfinished = lineStart < position;
    const continuation = unfinished && discard ? {lineStart,position,discard} : null;
    const pendingTelemetry = position < st.size || (unfinished && !['irrelevant','bootstrap-prefix'].includes(discard));
    return {rows,offset:continuation ? position : lineStart,readerState:continuation,
      size:st.size,identity:`${st.dev}:${st.ino}`,gap,invalidRows,skippedIrrelevantLines,pendingTelemetry};
  } finally { fs.closeSync(fd); }
}

function validRollout(c, filename) {
  const resolved = fs.realpathSync(filename);
  const home = fs.realpathSync(c.codexHome);
  const roots = ['sessions','archived_sessions'].flatMap(name => {
    try { return [fs.realpathSync(path.join(home,name)) + path.sep]; } catch { return []; }
  });
  if (!roots.some(root=>resolved.startsWith(root)) || !resolved.endsWith('.jsonl')) throw new Error('unsupported-rollout');
  return resolved;
}

export async function collect(db, c, { quotaReader = readQuota, discoverThreads = discover } = {}) {
  const observation = await quotaReader(c);
  observation.samplerVersion = SAMPLER_VERSION;
  observation.telemetryPending = false;
  const current = campaign(db);
  if (!current) throw new Error('Run begin before collect');
  if (JSON.stringify(current.config) !== JSON.stringify(c)) throw new Error('Configuration changed; begin a new measurement');
  const gapInsert = db.prepare('INSERT INTO gaps(campaign,timestamp,body) VALUES(?,?,?)');
  const gap = (reason, threadId = null) => gapInsert.run(current.id, observation.timestamp, JSON.stringify({ reason, threadId }));
  const threads = discoverThreads(c, Math.floor(Date.now()/1000) - 48*3600);
  let inserted = 0, baselineFiles = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Serialize collectors and measurement resets before looking up offsets.
    if (campaign(db)?.id !== current.id) throw new Error('Measurement changed during sampling');
    const firstAccount = db.prepare("SELECT body FROM snapshots WHERE campaign=? AND json_extract(body,'$.accountKey') IS NOT NULL ORDER BY id LIMIT 1").get(current.id);
    const expectedAccount = firstAccount && JSON.parse(firstAccount.body).accountKey;
    const changedAccount = expectedAccount && observation.accountKey && expectedAccount !== observation.accountKey;
    if (changedAccount) { observation.quota = null; observation.error = 'account-changed-begin-new-measurement'; }
    if (!observation.accountKey || !observation.quota) gap(observation.error || 'quota-unavailable');
    for (const thread of changedAccount ? [] : threads) {
      try {
        const filename = validRollout(c, thread.rollout_path);
        const stored = db.prepare('SELECT state FROM cursors WHERE thread_id=?').get(thread.id);
        let cursor = stored ? JSON.parse(stored.state) : initialCursor({
          createdAt: new Date(thread.created_at_ms || thread.created_at * 1000).toISOString(),
          model: thread.model, effort: thread.reasoning_effort });
        const accountChanged = cursor.accountKey && cursor.accountKey !== observation.accountKey;
        let bootstrap = !stored || accountChanged;
        const stat = fs.statSync(filename), identity = `${stat.dev}:${stat.ino}`;
        if (stored && (stat.size < cursor.offset || cursor.identity !== identity || accountChanged)) {
          gap(accountChanged ? 'account-changed' : 'file-replaced-or-truncated', thread.id);
          const generation = (cursor.generation || 0)+1;
          cursor = initialCursor({ createdAt: cursor.createdAt, model: thread.model, effort: thread.reasoning_effort });
          cursor.generation = generation;
          bootstrap = true;
        }
        // Existing files baseline at EOF. A new thread born after begin can be
        // consumed from the beginning, with copied pre-creation rows suppressed.
        const newThread = !stored && cursor.createdAt >= current.started_at;
        if (newThread) {
          bootstrap = false;
          cursor.baseline = { input_tokens:0,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:0 };
          cursor.recordBaseline = { ...cursor.baseline };
        }
        const result = readRows(filename, cursor.offset, { tail: bootstrap, readerState:cursor.readerState });
        cursor.identity = result.identity; cursor.accountKey = observation.accountKey || null;
        if (result.invalidRows && !bootstrap) gap('invalid-json-row', thread.id);
        if (result.gap) gap(result.gap,thread.id);
        observation.telemetryPending ||= result.pendingTelemetry;
        {
          for (const entry of result.rows) {
            const value = consumeRow(cursor, entry.row, { bootstrap, measurementStartedAt: current.started_at, offset: entry.offset });
            if (value.gap && !bootstrap) gap(value.gap, thread.id);
            if (value.event && observation.accountKey) {
              const event = { ...value.event, accountKey: observation.accountKey };
              const added = Number(db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?)')
                .run(current.id, `${thread.id}:${cursor.generation || 0}`, entry.offset, event.timestamp, JSON.stringify(event)).changes);
              inserted += added;
              if (added) updateModelTotal(db,current.id,event);
            }
          }
          cursor.offset = result.offset;
          cursor.readerState = result.readerState;
        }
        if (bootstrap) baselineFiles++;
        db.prepare('INSERT INTO cursors VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET state=excluded.state').run(thread.id, JSON.stringify(cursor));
      } catch { gap('thread-read-failed', thread.id); }
    }
    db.prepare('INSERT INTO snapshots(campaign,timestamp,body) VALUES(?,?,?)').run(current.id, observation.timestamp, JSON.stringify(observation));
    advanceCalibration(db,current,c,observation);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const report = reportFromStore(db, c);
  writeReport(c, report);
  return { campaign: current.id, sampledAt: observation.timestamp, threads: threads.length,
    inserted, baselineFiles, quotaPercent: observation.quota?.usedPercent ?? null,
    quotaError: observation.error, reportPath: path.join(c.stateDir,'report.md') };
}

function updateModelTotal(db, id, event) {
  const old = db.prepare('SELECT body FROM model_totals WHERE campaign=? AND model_key=?').get(id,event.modelKey);
  const m = old ? JSON.parse(old.body) : { modelKey: event.modelKey, model: event.model, speed: event.speed,
    efforts: {}, usageIncrements: 0, totals: Object.fromEntries([...COUNTERS,'uncached_input_tokens'].map(k=>[k,0])) };
  for (const k of Object.keys(m.totals)) m.totals[k] += event[k];
  m.efforts[event.effort] = (m.efforts[event.effort] || 0)+1; m.usageIncrements++;
  db.prepare('INSERT INTO model_totals VALUES(?,?,?) ON CONFLICT(campaign,model_key) DO UPDATE SET body=excluded.body').run(id,event.modelKey,JSON.stringify(m));
}

function advanceCalibration(db, current, c, observation) {
  const stored = db.prepare('SELECT body FROM anchors WHERE campaign=?').get(current.id);
  const old = stored ? JSON.parse(stored.body) : null;
  const priorRow = db.prepare('SELECT body FROM snapshots WHERE campaign=? ORDER BY id DESC LIMIT 1 OFFSET 1').get(current.id);
  const prior = priorRow ? JSON.parse(priorRow.body) : null;
  let anchor = old;
  if (!sameQuotaEpoch(old,observation) || !sameQuotaEpoch(prior,observation)
      || prior.samplerVersion !== observation.samplerVersion
      || observation.quota.usedPercent < prior.quota.usedPercent
      || Date.parse(observation.timestamp)-Date.parse(prior.timestamp)>180000) anchor = observation;
  else if (!observation.telemetryPending && observation.quota.usedPercent-anchor.quota.usedPercent >= (c.minimumQuotaDelta ?? 5)
      && Date.parse(observation.timestamp)-Date.parse(anchor.timestamp) >= (c.minimumSegmentSeconds ?? 300)*1000) {
    const read = table => db.prepare(`SELECT timestamp,body FROM ${table} WHERE campaign=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp`)
      .all(current.id,anchor.timestamp,observation.timestamp).map(row=>({...JSON.parse(row.body),timestamp:row.timestamp}));
    const r = buildReport({ snapshots:read('snapshots'),events:read('events'),gaps:read('gaps'),config:c,startedAt:current.started_at });
    for (const s of [...r.calibrationSegments,...r.excludedSegments]) db.prepare('INSERT OR IGNORE INTO segments VALUES(?,?,?,?)').run(current.id,s.start,s.end,JSON.stringify(s));
    anchor = observation;
  }
  db.prepare('INSERT INTO anchors VALUES(?,?) ON CONFLICT(campaign) DO UPDATE SET body=excluded.body').run(current.id,JSON.stringify(anchor));
}

export function reportFromStore(db, c) {
  const current = campaign(db);
  if (!current) throw new Error('Run begin before report');
  const latest = db.prepare('SELECT body FROM snapshots WHERE campaign=? ORDER BY id DESC LIMIT 1').get(current.id);
  const latestValue = latest ? JSON.parse(latest.body) : null;
  const anchorRow = db.prepare('SELECT body FROM anchors WHERE campaign=?').get(current.id);
  const anchor = anchorRow ? JSON.parse(anchorRow.body) : null;
  const report = buildReport({ snapshots: latestValue ? [latestValue] : [], events: [],
    modelTotals: db.prepare('SELECT body FROM model_totals WHERE campaign=?').all(current.id).map(r=>JSON.parse(r.body)),
    savedSegments: db.prepare('SELECT body FROM segments WHERE campaign=? ORDER BY start').all(current.id).map(r=>JSON.parse(r.body)),
    pendingState: anchor?.quota && latestValue?.quota ? { start:anchor.timestamp,
      quotaDelta:latestValue.quota.usedPercent-anchor.quota.usedPercent, minimumQuotaDelta:c.minimumQuotaDelta ?? 5,
      minimumSegmentSeconds:c.minimumSegmentSeconds ?? 300 } : null,
    config: current.config, startedAt: current.started_at });
  report.coverageGaps = db.prepare('SELECT count(*) n FROM gaps WHERE campaign=?').get(current.id).n;
  const firstRow = db.prepare('SELECT body FROM snapshots WHERE campaign=? ORDER BY id LIMIT 1').get(current.id);
  const first = firstRow ? JSON.parse(firstRow.body) : null;
  const delta = first?.quota && latestValue?.quota ? latestValue.quota.usedPercent-first.quota.usedPercent : 0;
  const n = report.observedTokens.total_tokens;
  report.preliminary = sameQuotaEpoch(first,latestValue) && !latestValue.telemetryPending && delta > 0 && n > 0 && report.byModel.length === 1
    && latestValue.quota.usedPercent < 100 ? {
      status:'very-low-confidence-observation-not-calibration', model:report.byModel[0].model,
      start:first.timestamp,end:latestValue.timestamp,quotaPercentagePoints:delta,observedTokens:n,
      tokensPerWeeklyPercentagePoint:n/delta,
      allocatedUsdPerMillionObservedTokens:delta*report.money.usdPerWeeklyPercentagePoint*1e6/n,
      roundingEnvelopeOnlyUsdPerMillion:{low:Math.max(0,delta-2)*report.money.usdPerWeeklyPercentagePoint*1e6/n,
        high:(delta+2)*report.money.usdPerWeeklyPercentagePoint*1e6/n},
      cachedShareOfInput:report.observedTokens.input_tokens ? report.observedTokens.cached_input_tokens/report.observedTokens.input_tokens : null,
      historicalCoverageGaps:report.coverageGaps,externalUsageVerified:false,separateInputOutputPrices:null
    } : null;
  return { ...report, measurementId: current.id };
}

export function writeReport(c, report) {
  for (const [name,content] of [['report.json', JSON.stringify(report,null,2)+'\n'],['report.md',renderMarkdown(report)]]) {
    const destination = path.join(c.stateDir,name), temporary = destination + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary,content,{mode:0o600}); fs.renameSync(temporary,destination);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let db;
  try {
    const command = process.argv[2], index = process.argv.indexOf('--config');
    if (!['begin','collect','report'].includes(command) || index < 0 || !process.argv[index+1]) {
      throw new Error('Usage: codex-subscription-meter.mjs begin|collect|report --config /private/config.json');
    }
    const c = validateConfig(JSON.parse(fs.readFileSync(process.argv[index+1],'utf8')));
    db = openStore(c);
    let result;
    if (command === 'begin') { result = begin(db,c); writeReport(c, reportFromStore(db,c)); }
    if (command === 'collect') result = await collect(db,c);
    if (command === 'report') { result = reportFromStore(db,c); writeReport(c,result); }
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } catch (error) {
    // Never include native/provider errors, HTTP bodies, filesystem contents or credentials.
    const allowed = /^(Usage:|Invalid |monthlyUsd |minimumQuotaDelta |minimumSegmentSeconds |State must |Run begin |Configuration changed|Measurement changed)/;
    process.stderr.write((allowed.test(error.message) ? error.message : 'Subscription meter failed; inspect local configuration and source availability.')+'\n');
    process.exitCode = 1;
  } finally { db?.close(); }
}
