import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { allowedPath, validateInventory, inspectJsonl, SOURCE } from './backup.mjs';

test('allowlist contains conversations and indexes only', () => {
  for (const p of ['sessions/2026/10/08/rollout-2026-10-08-abc.jsonl',
    'archived_sessions/rollout-abc.jsonl', 'session_index.jsonl', 'history.jsonl']) assert.equal(allowedPath(p), true);
  for (const p of ['auth.json', 'config.toml', '../history.jsonl', '/history.jsonl',
    'sessions/../auth.json', 'C:/Users/user/.codex/history.jsonl', 'sessions/keys.jsonl',
    'sessions/2026/10/08/rollout-x.jsonl\n', 'sessions/2026/10/08/rollout-"x.jsonl']) assert.equal(allowedPath(p), false);
});
test('rejects other machines, other users, other roots and empty inventory', () => {
  const data = { computer: 'me', user: 'showp', root: SOURCE.root,
    files: [{ path: 'sessions/2026/10/08/rollout-abc.jsonl', bytes: 30 }] };
  assert.equal(validateInventory(data), data);
  for (const patch of [{ computer: 'BEAM' }, { user: 'user' }, { root: 'C:/other' },
    { files: [] }, { files: [{ path: 'auth.json', bytes: 1 }] },
    { files: [...data.files, ...data.files] }]) assert.throws(() => validateInventory({ ...data, ...patch }));
});
test('validates complete records, retains unfinished tail and hashes exact bytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-history-unit-'));
  const file = path.join(dir, 'synthetic.jsonl');
  try {
    await fs.writeFile(file, '{"type":"session_meta"}\n{"message":"synthetic"}\n{"partial":');
    const result = await inspectJsonl(file);
    assert.equal(result.records, 2);
    assert.equal(result.trailingPartialBytes, 11);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    await fs.writeFile(file, '{"complete":true}\nnot-json\n');
    await assert.rejects(inspectJsonl(file), /INVALID_COMPLETE_JSONL_RECORD/);
    await fs.writeFile(file, '{"complete":true}');
    assert.equal((await inspectJsonl(file)).records, 1);
  } finally { await fs.rm(dir, { recursive: true }); }
});
