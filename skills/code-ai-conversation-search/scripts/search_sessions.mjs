#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const STOP_WORDS = new Set([
  'אני', 'אתה', 'את', 'על', 'של', 'עם', 'זה', 'זו', 'הזה', 'הזאת', 'היא', 'הוא', 'גם', 'כל',
  'מה', 'איפה', 'איך', 'למה', 'משהו', 'מערכת', 'שיחה', 'שיחות', 'סשן', 'סשנים', 'פרויקט',
  'תבדוק', 'תחפש', 'חפש', 'מצא', 'the', 'and', 'for', 'with', 'from', 'that', 'this', 'project',
  'session', 'sessions', 'find', 'search',
]);

function parseArguments(argv) {
  const values = new Map();
  const repeated = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : 'true';
    values.set(name, value);
    const list = repeated.get(name) || [];
    list.push(value);
    repeated.set(name, list);
  }
  return { values, repeated };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function distinctiveTerms(query) {
  const tokens = normalizeText(query)
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}._:/-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
  return [...new Set(tokens)].sort((left, right) => right.length - left.length).slice(0, 8);
}

function parseProfiles(rawProfiles) {
  const profiles = [];
  for (const raw of rawProfiles) {
    const separator = raw.indexOf('=');
    if (separator <= 0 || separator === raw.length - 1) continue;
    profiles.push({ id: raw.slice(0, separator).trim(), codexHome: path.resolve(raw.slice(separator + 1).trim()) });
  }
  if (profiles.length === 0 && process.env.CODEX_HOME) {
    profiles.push({ id: 'current', codexHome: path.resolve(process.env.CODEX_HOME) });
  }
  return profiles;
}

async function existingSearchRoots(profile) {
  const roots = [];
  for (const directory of ['sessions', 'archived_sessions']) {
    const candidate = path.join(profile.codexHome, directory);
    const resolved = await fs.realpath(candidate).catch(() => null);
    if (resolved && (await fs.stat(resolved).catch(() => null))?.isDirectory()) roots.push(resolved);
  }
  return roots;
}

async function listJsonlFiles(root, output, maximum) {
  if (output.length >= maximum) return;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (output.length >= maximum) return;
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) await listJsonlFiles(candidate, output, maximum);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(candidate);
  }
}

async function readSessionMeta(filePath) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      try {
        const row = JSON.parse(line);
        if (row?.type === 'session_meta' && row?.payload?.id) {
          return {
            id: String(row.payload.id),
            cwd: normalizeText(row.payload.cwd),
            createdAt: normalizeText(row.payload.timestamp || row.timestamp),
            forkedFromId: normalizeText(row.payload.forked_from_id) || null,
          };
        }
      } catch {
        // Ignore malformed historical rows and keep looking for metadata.
      }
      break;
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return null;
}

function safeIndexToken(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function indexedMessage(extracted, lineNumber = 0) {
  return {
    type: 'conversation_message_v1',
    timestamp: extracted.timestamp,
    role: extracted.role,
    message: extracted.message,
    lineNumber,
  };
}

function extractIndexedMessage(row) {
  if (row?.type !== 'conversation_message_v1') return null;
  const role = row.role === 'user' || row.role === 'assistant' ? row.role : null;
  const message = normalizeText(row.message);
  if (!role || !message) return null;
  return {
    role,
    message,
    timestamp: normalizeText(row.timestamp),
    lineNumber: Number(row.lineNumber) || 0,
  };
}

async function waitForIndexLock(lockPath) {
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8');
      await handle.close();
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const lockStat = await fs.stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > 5 * 60_000) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedAt > 30_000) throw new Error(`Timed out waiting for conversation-search index lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function readIndexManifest(manifestPath, profileId) {
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (parsed?.version === 1 && parsed?.profileId === profileId && parsed.files && typeof parsed.files === 'object') return parsed;
  } catch {
    // Missing or damaged search indexes are safely rebuilt from immutable session history.
  }
  return { version: 1, profileId, updatedAt: null, files: {} };
}

async function persistIndexManifest(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, manifestPath);
}

async function closeWriters(writers) {
  await Promise.all([...writers.values()].map(async (writer) => {
    writer.end();
    await once(writer, 'finish');
  }));
}

async function buildFreshIndexes(freshEntries) {
  if (freshEntries.length === 0) return;
  const bySource = new Map(freshEntries.map((entry) => [entry.sourceFile, entry]));
  const child = spawn('rg', [
    '--json', '-F',
    '-e', '"type":"user_message"',
    '-e', '"type":"agent_message"',
    '--',
    ...freshEntries.map((entry) => entry.sourceFile),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0 && code !== 1) reject(new Error(stderr.trim() || `rg exited with ${code}`));
      else resolve();
    });
  });
  const writers = new Map();
  const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const eventLine of reader) {
      let event;
      try { event = JSON.parse(eventLine); } catch { continue; }
      if (event?.type !== 'match') continue;
      const sourceFile = normalizeText(event.data?.path?.text);
      const sourceLine = normalizeText(event.data?.lines?.text);
      const entry = bySource.get(sourceFile);
      if (!entry || !sourceLine) continue;
      let row;
      try { row = JSON.parse(sourceLine); } catch { continue; }
      const extracted = extractMessage(row);
      if (!extracted) continue;
      let writer = writers.get(entry.indexFile);
      if (!writer) {
        writer = createWriteStream(entry.indexFile, { flags: 'a', encoding: 'utf8', mode: 0o600 });
        writers.set(entry.indexFile, writer);
      }
      if (!writer.write(`${JSON.stringify(indexedMessage(extracted, Number(event.data?.line_number) || 0))}\n`)) {
        await once(writer, 'drain');
      }
    }
    await completion;
  } finally {
    reader.close();
    await closeWriters(writers);
  }
}

async function appendIndexFromOffset(entry, startOffset, endOffset) {
  if (endOffset <= startOffset) return;
  const source = createReadStream(entry.sourceFile, { encoding: 'utf8', start: startOffset, end: endOffset - 1 });
  const reader = readline.createInterface({ input: source, crlfDelay: Infinity });
  const writer = createWriteStream(entry.indexFile, { flags: 'a', encoding: 'utf8', mode: 0o600 });
  try {
    for await (const sourceLine of reader) {
      let row;
      try { row = JSON.parse(sourceLine); } catch { continue; }
      const extracted = extractMessage(row);
      if (!extracted) continue;
      if (!writer.write(`${JSON.stringify(indexedMessage(extracted))}\n`)) await once(writer, 'drain');
    }
  } finally {
    reader.close();
    source.destroy();
    writer.end();
    await once(writer, 'finish');
  }
}

async function updateProfileIndex(profile, roots, indexRoot) {
  const profileRoot = path.join(indexRoot, safeIndexToken(profile.id));
  const messagesRoot = path.join(profileRoot, 'messages');
  const manifestPath = path.join(profileRoot, 'manifest.json');
  const lockPath = path.join(profileRoot, '.update.lock');
  await fs.mkdir(messagesRoot, { recursive: true, mode: 0o700 });
  await waitForIndexLock(lockPath);
  const startedAt = Date.now();
  try {
    const manifest = await readIndexManifest(manifestPath, profile.id);
    const sourceFiles = [];
    for (const root of roots) await listJsonlFiles(root, sourceFiles, 100_000);
    const sourceSet = new Set(sourceFiles);
    for (const [sourceFile, previous] of Object.entries(manifest.files)) {
      if (sourceSet.has(sourceFile)) continue;
      if (previous?.indexFile) await fs.rm(previous.indexFile, { force: true });
      delete manifest.files[sourceFile];
    }

    const freshEntries = [];
    const appendedEntries = [];
    let unchangedFiles = 0;
    for (const sourceFile of sourceFiles) {
      const stat = await fs.stat(sourceFile).catch(() => null);
      if (!stat?.isFile()) continue;
      const previous = manifest.files[sourceFile];
      const sameIdentity = previous
        && Number(previous.ino || 0) === Number(stat.ino || 0)
        && Number(previous.offset || 0) <= stat.size;
      if (sameIdentity && Number(previous.offset || 0) === stat.size) {
        unchangedFiles += 1;
        continue;
      }
      const meta = sameIdentity && previous?.meta ? previous.meta : await readSessionMeta(sourceFile);
      if (!meta) continue;
      const indexFile = sameIdentity && previous?.indexFile
        ? previous.indexFile
        : path.join(messagesRoot, `${safeIndexToken(sourceFile)}.jsonl`);
      const entry = {
        sourceFile,
        indexFile,
        meta,
        ino: Number(stat.ino || 0),
        offset: stat.size,
        mtimeMs: stat.mtimeMs,
      };
      if (!sameIdentity) {
        await fs.writeFile(indexFile, '', { encoding: 'utf8', mode: 0o600 });
        freshEntries.push(entry);
      } else {
        appendedEntries.push({ entry, startOffset: Number(previous.offset || 0), endOffset: stat.size });
      }
      manifest.files[sourceFile] = entry;
    }
    await buildFreshIndexes(freshEntries);
    for (const appended of appendedEntries) {
      await appendIndexFromOffset(appended.entry, appended.startOffset, appended.endOffset);
    }
    manifest.updatedAt = new Date().toISOString();
    await persistIndexManifest(manifestPath, manifest);
    return {
      profileId: profile.id,
      profileRoot,
      entries: Object.values(manifest.files),
      freshFiles: freshEntries.length,
      appendedFiles: appendedEntries.length,
      unchangedFiles,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}

function isInsideProject(projectRoot, cwd) {
  if (!projectRoot || !cwd) return false;
  const relative = path.relative(path.resolve(projectRoot), path.resolve(cwd));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function extractMessage(row) {
  if (row?.type !== 'event_msg') return null;
  if (row?.payload?.type !== 'user_message' && row?.payload?.type !== 'agent_message') return null;
  const message = normalizeText(row.payload.message);
  if (!message) return null;
  return {
    role: row.payload.type === 'user_message' ? 'user' : 'assistant',
    message,
    timestamp: normalizeText(row.timestamp),
  };
}

function scoreMessage(message, query, terms) {
  const source = message.toLocaleLowerCase();
  const exact = query.toLocaleLowerCase();
  let score = exact && source.includes(exact) ? 120 : 0;
  let matchedTerms = 0;
  for (const term of terms) {
    if (source.includes(term.toLocaleLowerCase())) {
      matchedTerms += 1;
      score += Math.min(24, 6 + term.length);
    }
  }
  if (terms.length > 1 && matchedTerms === terms.length) score += 30;
  return { score, matchedTerms };
}

function excerptAround(message, query, terms, length = 700) {
  const lower = message.toLocaleLowerCase();
  const needles = [query, ...terms].map((value) => value.toLocaleLowerCase()).filter(Boolean);
  const indexes = needles.map((needle) => lower.indexOf(needle)).filter((index) => index >= 0);
  const focus = indexes.length > 0 ? Math.min(...indexes) : 0;
  const start = Math.max(0, focus - Math.floor(length / 3));
  const end = Math.min(message.length, start + length);
  return `${start > 0 ? '…' : ''}${message.slice(start, end)}${end < message.length ? '…' : ''}`;
}

async function scanMessagesBatch(filePaths, query, terms, minimumScoreByFile, searchPatterns) {
  if (filePaths.length === 0) return { matchesByFile: new Map(), exactFiles: new Set() };
  const patterns = [...new Set(searchPatterns.map(normalizeText).filter(Boolean))];
  const argumentsList = ['--json', '-i', '-F', '--max-count', '100'];
  for (const pattern of patterns) argumentsList.push('-e', pattern);
  argumentsList.push('--', ...filePaths);
  const child = spawn('rg', argumentsList, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0 && code !== 1) reject(new Error(stderr.trim() || `rg exited with ${code}`));
      else resolve();
    });
  });
  const matchesByFile = new Map();
  const exactFiles = new Set();
  const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const eventLine of reader) {
      let event;
      try { event = JSON.parse(eventLine); } catch { continue; }
      if (event?.type !== 'match') continue;
      const filePath = normalizeText(event.data?.path?.text);
      const sourceLine = normalizeText(event.data?.lines?.text);
      if (!filePath || !sourceLine || !minimumScoreByFile.has(filePath)) continue;
      let row;
      try { row = JSON.parse(sourceLine); } catch { continue; }
      const extracted = extractIndexedMessage(row) || extractMessage(row);
      if (!extracted) continue;
      if (extracted.message.toLocaleLowerCase().includes(query.toLocaleLowerCase())) exactFiles.add(filePath);
      const scored = scoreMessage(extracted.message, query, terms);
      if (scored.score < minimumScoreByFile.get(filePath)) continue;
      const matches = matchesByFile.get(filePath) || [];
      matches.push({
        ...extracted,
        lineNumber: Number(extracted.lineNumber) || Number(event.data?.line_number) || 0,
        score: scored.score,
        excerpt: excerptAround(extracted.message, query, terms),
        fingerprint: createHash('sha256')
          .update(`${extracted.timestamp}\0${extracted.role}\0${extracted.message}`)
          .digest('hex'),
      });
      matchesByFile.set(filePath, matches);
    }
    await completion;
  } finally {
    reader.close();
  }
  return { matchesByFile, exactFiles };
}

async function readTitles(titlesFile) {
  if (!titlesFile) return {};
  try {
    const parsed = JSON.parse(await fs.readFile(path.resolve(titlesFile), 'utf8'));
    return parsed?.titles && typeof parsed.titles === 'object' ? parsed.titles : {};
  } catch {
    return {};
  }
}

async function main() {
  const { values, repeated } = parseArguments(process.argv.slice(2));
  const scope = values.get('scope') || 'current';
  const query = normalizeText(values.get('query'));
  const sessionId = normalizeText(values.get('session-id'));
  const projectRoot = normalizeText(values.get('project-root'));
  const limit = Math.min(100, Math.max(1, Number.parseInt(values.get('limit') || '20', 10) || 20));
  const baseUrl = normalizeText(values.get('base-url')).replace(/\/+$/, '');
  const titlesFile = normalizeText(values.get('titles-file'));
  const indexRoot = path.resolve(
    normalizeText(values.get('index-root'))
      || path.join(path.dirname(titlesFile || path.join(process.cwd(), 'session-titles.json')), 'local', 'conversation-search-mode', 'index-v1'),
  );
  const profiles = parseProfiles(repeated.get('profile') || []);
  if (!['current', 'project', 'all'].includes(scope)) return fail('scope must be current, project, or all');
  if (!query) return fail('query is required');
  if (scope === 'current' && !sessionId) return fail('session-id is required for current scope');
  if (scope === 'project' && !projectRoot) return fail('project-root is required for project scope');
  if (profiles.length === 0) return fail('at least one --profile id=/path/to/.codex is required');

  const warnings = [];
  const profileRoots = [];
  for (const profile of profiles) {
    const roots = await existingSearchRoots(profile);
    if (roots.length === 0) warnings.push(`No readable session roots for profile ${profile.id}`);
    profileRoots.push({ ...profile, roots });
  }
  await fs.mkdir(indexRoot, { recursive: true, mode: 0o700 });
  const indexedProfiles = [];
  for (const profile of profileRoots) {
    const index = await updateProfileIndex(profile, profile.roots, indexRoot);
    indexedProfiles.push({ ...profile, index });
  }
  const indexedEntries = indexedProfiles.flatMap((profile) => (
    profile.index.entries.map((entry) => ({ ...entry, owner: profile }))
  ));
  const indexedEntryByFile = new Map(indexedEntries.map((entry) => [entry.indexFile, entry]));
  const terms = distinctiveTerms(query);
  const titles = await readTitles(titlesFile);
  const minimumScoreByFile = new Map();
  const metadataByFile = new Map();
  const ownerByFile = new Map();
  const eligibleFiles = [];
  for (const entry of indexedEntries) {
    const filePath = entry.indexFile;
    const owner = entry.owner;
    const meta = entry.meta;
    if (scope === 'current' && meta.id !== sessionId) continue;
    if (scope === 'project' && !isInsideProject(projectRoot, meta.cwd)) continue;
    eligibleFiles.push(filePath);
    ownerByFile.set(filePath, owner);
    metadataByFile.set(filePath, meta);
    minimumScoreByFile.set(filePath, terms.length === 0 ? 1 : 8);
  }
  let searchResult = await scanMessagesBatch(eligibleFiles, query, terms, minimumScoreByFile, [query]);
  if (searchResult.matchesByFile.size === 0 && terms.length > 0) {
    searchResult = await scanMessagesBatch(eligibleFiles, query, terms, minimumScoreByFile, [terms[0]]);
  }
  const { matchesByFile, exactFiles } = searchResult;
  const acceptedFiles = [...matchesByFile.keys()];
  const rawMatches = [];
  for (const filePath of acceptedFiles) {
    const owner = ownerByFile.get(filePath);
    const meta = metadataByFile.get(filePath);
    if (!owner || !meta) continue;
    const messages = matchesByFile.get(filePath) || [];
    for (const match of messages) {
      rawMatches.push({
        ...match,
        profileId: owner.id,
        sessionId: meta.id,
        sessionCreatedAt: meta.createdAt,
        forkedFromId: meta.forkedFromId,
        cwd: meta.cwd,
        title: normalizeText(titles[`${owner.id}:${meta.id}`]) || null,
        sourceFile: indexedEntryByFile.get(filePath)?.sourceFile || filePath,
      });
    }
  }

  const deduplicated = new Map();
  for (const match of rawMatches) {
    const sameSessionKey = `${match.fingerprint}:${match.profileId}:${match.sessionId}`;
    const relatedForkEntry = [...deduplicated.entries()].find(([, current]) => (
      current.fingerprint === match.fingerprint
      && current.profileId === match.profileId
      && (
        match.forkedFromId === current.sessionId
        || current.forkedFromId === match.sessionId
        || (match.forkedFromId && match.forkedFromId === current.forkedFromId)
      )
    ));
    const selectedKey = relatedForkEntry?.[0] || sameSessionKey;
    const current = deduplicated.get(selectedKey);
    if (!current || String(match.sessionCreatedAt) < String(current.sessionCreatedAt)) {
      deduplicated.set(selectedKey, match);
    }
  }
  const matches = [...deduplicated.values()]
    .sort((left, right) => right.score - left.score || String(right.timestamp).localeCompare(String(left.timestamp)))
    .slice(0, limit)
    .map(({ fingerprint, message, ...match }) => ({
      ...match,
      link: baseUrl ? `${baseUrl}/session/${encodeURIComponent(match.profileId)}/${encodeURIComponent(match.sessionId)}` : null,
    }));

  process.stdout.write(`${JSON.stringify({
    query,
    scope,
    sessionId: scope === 'current' ? sessionId : null,
    projectRoot: scope === 'project' ? path.resolve(projectRoot) : null,
    searchedProfiles: profileRoots.map((profile) => ({ id: profile.id, codexHome: profile.codexHome, roots: profile.roots })),
    index: {
      root: indexRoot,
      profiles: indexedProfiles.map((profile) => ({
        id: profile.id,
        indexedFiles: profile.index.entries.length,
        freshFiles: profile.index.freshFiles,
        appendedFiles: profile.index.appendedFiles,
        unchangedFiles: profile.index.unchangedFiles,
        elapsedMs: profile.index.elapsedMs,
      })),
    },
    exactPhraseMatchedFiles: exactFiles.size,
    candidateFiles: matchesByFile.size,
    eligibleFiles: eligibleFiles.length,
    totalMatchesBeforeLimit: deduplicated.size,
    matches,
    warnings,
  }, null, 2)}\n`);
}

main().catch((error) => {
  fail(error?.stack || String(error));
});
