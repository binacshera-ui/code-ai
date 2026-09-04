import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildWorkspaceMovePrompt,
  deleteSessionWorkspaceOverride,
  getSessionWorkspaceMap,
  getSessionWorkspaceOverride,
  rebindSessionWorkspaceOverride,
  setSessionWorkspaceOverride,
  setSessionWorkspaceOverrides,
} from './codexSessionWorkspaces.js';
import {
  createSessionTopic,
  listSessionTopics,
  moveSessionTopic,
  setSessionTopic,
} from './codexSessionTopics.js';

test('workspace overrides persist, batch, rebind and delete independently per profile', async () => {
  const storageRoot = process.env.CODEX_STORAGE_ROOT;
  assert.ok(storageRoot, 'CODEX_STORAGE_ROOT must be configured for this test');

  await setSessionWorkspaceOverride('profile-a', 'session-1', '/work/alpha');
  await setSessionWorkspaceOverrides('profile-a', ['session-2', 'session-3'], '/work/beta');
  await setSessionWorkspaceOverride('profile-b', 'session-1', '/work/other-profile');

  const profileAMap = await getSessionWorkspaceMap('profile-a');
  assert.equal(profileAMap['session-1']?.cwd, '/work/alpha');
  assert.equal(profileAMap['session-2']?.cwd, '/work/beta');
  assert.equal(profileAMap['session-3']?.cwd, '/work/beta');
  assert.equal(profileAMap['session-1']?.profileId, 'profile-a');

  await rebindSessionWorkspaceOverride('profile-a', 'session-1', 'session-1-recovered');
  assert.equal(
    (await getSessionWorkspaceOverride('profile-a', 'session-1-recovered'))?.cwd,
    '/work/alpha',
  );

  await deleteSessionWorkspaceOverride('profile-a', 'session-1');
  assert.equal(await getSessionWorkspaceOverride('profile-a', 'session-1'), null);
  assert.equal(
    (await getSessionWorkspaceOverride('profile-b', 'session-1'))?.cwd,
    '/work/other-profile',
  );

  const persisted = JSON.parse(
    await fs.readFile(path.join(storageRoot, 'session-workspaces.json'), 'utf8'),
  ) as { assignments: Record<string, { cwd: string }> };
  assert.equal(persisted.assignments['profile-a:session-2']?.cwd, '/work/beta');
});

test('workspace move prompt carries the new active path into the session', () => {
  const prompt = buildWorkspaceMovePrompt('/root/projects/new-workspace');
  assert.match(prompt, /עברנו למקור תיקייה פעילה חדשה/u);
  assert.match(prompt, /הנתיב הפעיל הוא: \/root\/projects\/new-workspace/u);
  assert.match(prompt, /workspace הפעיל/u);
});

test('the same session can be moved repeatedly without stale workspace state', async () => {
  await setSessionWorkspaceOverride('profile-repeat', 'session-repeat', '/work/first');
  await setSessionWorkspaceOverride('profile-repeat', 'session-repeat', '/work/second');
  await setSessionWorkspaceOverride('profile-repeat', 'session-repeat', '/work/third');

  assert.equal(
    (await getSessionWorkspaceOverride('profile-repeat', 'session-repeat'))?.cwd,
    '/work/third',
  );
});

test('moving a topic keeps its assignments and exposes it only in the target folder', async () => {
  const topic = await createSessionTopic('profile-topic', '/work/source', {
    name: 'נושא בדיקה',
    icon: '🧪',
    colorKey: 'sky',
  });
  await setSessionTopic('profile-topic', 'topic-session-1', topic.id, '/work/source');
  await setSessionTopic('profile-topic', 'topic-session-2', topic.id, '/work/source');

  const result = await moveSessionTopic('profile-topic', topic.id, '/work/target');
  assert.equal(result.topic.cwd, '/work/target');
  assert.deepEqual(new Set(result.affectedSessionIds), new Set(['topic-session-1', 'topic-session-2']));
  assert.equal((await listSessionTopics('profile-topic', '/work/source')).length, 0);
  assert.equal((await listSessionTopics('profile-topic', '/work/target'))[0]?.assignedSessionCount, 2);

  const repeatedResult = await moveSessionTopic('profile-topic', topic.id, '/work/final-target');
  assert.equal(repeatedResult.topic.cwd, '/work/final-target');
  assert.deepEqual(new Set(repeatedResult.affectedSessionIds), new Set(['topic-session-1', 'topic-session-2']));
  assert.equal((await listSessionTopics('profile-topic', '/work/target')).length, 0);
  assert.equal((await listSessionTopics('profile-topic', '/work/final-target'))[0]?.assignedSessionCount, 2);
});
