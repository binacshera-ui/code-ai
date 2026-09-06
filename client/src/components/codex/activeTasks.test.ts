import assert from 'node:assert/strict';
import test from 'node:test';
import { activeTaskLabel, selectRunningTasks, type ActiveTaskItem } from './activeTasks';

const task = (id: string, status: string, profileId = 'one'): ActiveTaskItem => ({
  id, status, profileId, sessionId: null, queueKey: `draft:${id}`,
  startedAt: '2026-09-06T06:00:00Z', promptPreview: 'בקשה חדשה',
});

test('only executing or stopping tasks from the selected profile appear', () => {
  const rows = ['scheduled', 'queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled'].map(status => task(status, status));
  rows.push(task('other', 'running', 'two'));
  assert.deepEqual(selectRunningTasks(rows, 'one').map(item => item.status), ['cancelling', 'running']);
  assert.equal(selectRunningTasks(rows.map(item => ({ ...item, status: 'cancelled' })), 'one').length, 0);
  assert.equal(rows[0].status, 'scheduled'); // no mutation of shared queue data
});

test('stable order and titles work for existing sessions, filtered lists and new drafts', () => {
  const draft = task('draft', 'running');
  const existing = { ...task('existing', 'running'), sessionId: 'session', startedAt: '2026-09-06T05:00:00Z' };
  const titles = new Map([['session', 'שם השיחה']]);
  assert.equal(selectRunningTasks([draft, existing], 'one')[0].id, 'existing');
  assert.equal(activeTaskLabel(existing, titles), 'שם השיחה');
  assert.equal(activeTaskLabel(existing, new Map()), 'בקשה חדשה');
  assert.equal(activeTaskLabel(draft, titles), 'בקשה חדשה');
  assert.equal(activeTaskLabel({ ...draft, promptPreview: '   ' }, titles), 'שיחה חדשה');
});
