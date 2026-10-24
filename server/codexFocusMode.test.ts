import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

let root = '';
let api: typeof import('./codexFocusMode.js');
let originalStorageRoot: string | undefined;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-focus-mode-test-'));
  originalStorageRoot = process.env.CODEX_STORAGE_ROOT;
  process.env.CODEX_STORAGE_ROOT = root;
  // Native Node type-stripping qualification: resolve only this new module and
  // its config import. A bundled test needs no hook and matches neither path.
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './codexFocusMode.js' && context.parentURL?.endsWith('/codexFocusMode.test.ts')) {
        return nextResolve('./codexFocusMode.ts', context);
      }
      if (specifier === './config.js' && context.parentURL?.endsWith('/codexFocusMode.ts')) {
        return nextResolve('./config.ts', context);
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    api = await import('./codexFocusMode.js');
  } finally {
    hooks.deregister();
  }
});

after(async () => {
  if (originalStorageRoot === undefined) delete process.env.CODEX_STORAGE_ROOT;
  else process.env.CODEX_STORAGE_ROOT = originalStorageRoot;
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('load failures are recoverable without overwriting corrupt evidence', async () => {
  const modeRoot = path.join(root, 'local', 'focus-mode');
  const modeFile = path.join(modeRoot, 'session-focus-mode.json');
  await fs.mkdir(modeRoot, { recursive: true });
  await fs.writeFile(modeFile, '{broken-json');
  await assert.rejects(() => api.getSessionFocusMode('test', 'first'));
  assert.equal(await fs.readFile(modeFile, 'utf8'), '{broken-json');
  await fs.unlink(modeFile);
  assert.deepEqual(await api.getSessionFocusMode('test', 'first'), api.createEmptySessionFocusMode());
});

test('mode is opt-in, bounded, Codex-only, and does not leak disabled goals', async () => {
  assert.equal((await api.getSessionFocusMode('profile-one', 'draft')).enabled, false);
  assert.equal(await api.getSessionFocusModeRecord('profile-one', 'draft'), null);
  const normalized = await api.validateSessionFocusMode({ provider: 'codex' }, {
    enabled: true, goal: `\u0000  ${'a'.repeat(3_000)}  `,
  });
  assert.equal(normalized.goal.length, 2_000);
  assert.equal(normalized.goal.startsWith('\u0000'), false);
  await assert.rejects(() => api.validateSessionFocusMode({ provider: 'gemini' }, { enabled: true }), /Codex/);
  assert.equal((await api.validateSessionFocusMode({ provider: 'gemini' }, { enabled: false })).enabled, false);
  assert.doesNotMatch(api.buildSessionFocusModePromptAdditions({ mode: { ...normalized, enabled: false, goal: 'private-goal' } }), /private-goal/);
});

test('profile/session persistence, edits, draft rebind and deletion stay isolated', async () => {
  const first = await api.setSessionFocusMode('profile-one', 'draft', { enabled: true, goal: 'Deliver the requested result.' });
  await api.setSessionFocusMode('profile-two', 'draft', { enabled: true, goal: 'A different result.' });
  const edited = await api.setSessionFocusMode('profile-one', 'draft', { goal: 'Latest result.' });
  assert.equal(edited.enabled, true);
  assert.equal(edited.createdAt, first.createdAt);
  assert.ok(edited.updatedAt);
  edited.goal = 'Mutation of a returned copy';
  assert.equal((await api.getSessionFocusMode('profile-one', 'draft')).goal, 'Latest result.');
  await api.rebindSessionFocusMode('profile-one', 'draft', 'real-session');
  assert.equal(await api.getSessionFocusModeRecord('profile-one', 'draft'), null);
  assert.equal((await api.getSessionFocusMode('profile-one', 'real-session')).goal, 'Latest result.');
  assert.equal((await api.getSessionFocusMode('profile-two', 'draft')).goal, 'A different result.');
  await api.deleteSessionFocusMode('profile-one', 'real-session');
  assert.equal((await api.getSessionFocusMode('profile-one', 'real-session')).enabled, false);
  const modeFile = path.join(root, 'local', 'focus-mode', 'session-focus-mode.json');
  assert.equal((await fs.stat(modeFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(modeFile))).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await fs.readFile(modeFile, 'utf8')).modesByKey['profile-one:real-session'], undefined);
});

test('a failed persistence write does not poison later saves', async () => {
  const modeRoot = path.join(root, 'local', 'focus-mode');
  const parked = path.join(root, 'local', 'parked-focus-mode');
  await fs.rename(modeRoot, parked);
  await fs.writeFile(modeRoot, 'fixture blocking a directory');
  try {
    await assert.rejects(() => api.setSessionFocusMode('recovery-profile', 'draft', { enabled: true, goal: 'Recover this save.' }));
  } finally {
    await fs.unlink(modeRoot);
    await fs.rename(parked, modeRoot);
  }
  await api.setSessionFocusMode('recovery-profile', 'draft', { goal: 'Saved after failure.' });
  const persisted = JSON.parse(await fs.readFile(path.join(modeRoot, 'session-focus-mode.json'), 'utf8'));
  assert.equal(persisted.modesByKey['recovery-profile:draft'].goal, 'Saved after failure.');
  assert.deepEqual(await fs.readdir(modeRoot), ['session-focus-mode.json']);
});

test('rebind preserves an explicit canonical target preference, including disabled mode', async () => {
  await api.setSessionFocusMode('target-wins', 'draft', { enabled: true, goal: 'Superseded draft goal.' });
  const target = await api.setSessionFocusMode('target-wins', 'canonical', { enabled: false, goal: 'Explicit canonical goal.' });
  await api.rebindSessionFocusMode('target-wins', 'draft', 'canonical');
  assert.equal(await api.getSessionFocusModeRecord('target-wins', 'draft'), null);
  assert.deepEqual(await api.getSessionFocusModeRecord('target-wins', 'canonical'), target);
});

test('enabled prompt targets progress without weakening permissions or authoritative gates', () => {
  const prompt = api.buildSessionFocusModePromptAdditions({ mode: {
    ...api.createEmptySessionFocusMode(), enabled: true, goal: 'Finish the authorized feature.',
  } });
  for (const fragment of [
    'Finish the authorized feature.', 'בקשת המשתמש העדכנית', 'קובץ ההוראות המוסמך',
    'שני ניסיונות זהים', 'הפסק המשכים אוטומטיים', 'כל הוראות המערכת, המפתח והמשתמש',
    'שערי בקרת הפריסה המחייבים', 'אין לנסות שוב קלט שהתקבל', 'לא הרשאה נוספת',
  ]) assert.ok(prompt.includes(fragment), fragment);
});

test('engineering judgment challenges the method even when commands succeed, rather than adding governance', () => {
  const prompt = api.buildSessionFocusModePromptAdditions({ mode: { ...api.createEmptySessionFocusMode(), enabled: true } });
  for (const fragment of ['שיקול דעת הנדסי', 'גם פקודות שמצליחות', 'רפאל, הבעיה כאן אינה עוד תקלה נקודתית',
    'מה נמחק או מתאחד', 'אל תענה למורכבות מיותרת בעוד מנהל', 'בלי לבקש שוב רשות שכבר ניתנה',
    'מותר להמליץ לשנות נוהל מחייב', 'אין להפוך גם את הביקורת הזאת לטקס']) assert.ok(prompt.includes(fragment), fragment);
  assert.equal(prompt.includes('השתמש בבעלים, במנוע ובמסלול הביצוע הקיימים.'), false);
});
