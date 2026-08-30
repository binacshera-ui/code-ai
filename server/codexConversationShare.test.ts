import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildSharedConversationMarkdown,
  exportSharedConversations,
  sanitizeSharedConversationFileName,
} from './codexConversationShare.js';
import type { CodexSessionDetail, CodexTimelineEntry } from './codexService.js';

function createSession(
  id: string,
  title: string,
  timeline: CodexTimelineEntry[],
): CodexSessionDetail {
  return {
    id,
    title,
    updatedAt: '2026-08-08T08:00:00.000Z',
    createdAt: '2026-08-01T08:00:00.000Z',
    profileId: 'developer',
    cwd: '/tmp/project',
    messageCount: timeline.filter((entry) => entry.entryType === 'message').length,
    preview: 'preview',
    startPreview: 'start',
    endPreview: 'end',
    path: `/tmp/${id}.jsonl`,
    source: 'test',
    modelProvider: 'codex',
    messages: [],
    timeline,
    totalTimelineEntries: timeline.length,
    timelineWindowStart: 0,
    timelineWindowEnd: timeline.length,
    hasEarlierTimeline: false,
  };
}

test('shared Markdown includes only user prompts and final assistant responses', () => {
  const longFinal = `תוצאה מלאה ${'א'.repeat(25_000)}`;
  const session = createSession('session-123', 'שיחת בדיקה', [
    { id: 'status', entryType: 'status', timestamp: '2026-08-08T08:00:00.000Z', title: 'running' },
    { id: 'user-1', entryType: 'message', role: 'user', kind: 'prompt', timestamp: '2026-08-08T08:01:00.000Z', text: 'בנה פתרון מלא' },
    { id: 'tool', entryType: 'tool', timestamp: '2026-08-08T08:02:00.000Z', toolName: 'shell', toolOutputText: 'secret tool output' },
    { id: 'commentary', entryType: 'message', role: 'assistant', kind: 'commentary', timestamp: '2026-08-08T08:03:00.000Z', text: 'עובד על זה' },
    { id: 'final-1', entryType: 'message', role: 'assistant', kind: 'final', timestamp: '2026-08-08T08:04:00.000Z', text: longFinal },
    { id: 'transfer', entryType: 'message', role: 'user', kind: 'transfer', timestamp: '2026-08-08T08:05:00.000Z', text: 'transfer metadata' },
  ]);

  const result = buildSharedConversationMarkdown(session, new Date('2026-08-08T09:00:00.000Z'));

  assert.equal(result.messageCount, 2);
  assert.match(result.markdown, /בנה פתרון מלא/);
  assert.match(result.markdown, /תוצאה מלאה/);
  assert.equal(result.markdown.includes('א'.repeat(25_000)), true, 'final response was truncated');
  assert.doesNotMatch(result.markdown, /secret tool output/);
  assert.doesNotMatch(result.markdown, /עובד על זה/);
  assert.doesNotMatch(result.markdown, /transfer metadata/);
  assert.match(result.markdown, /הודעות ביניים, חשיבה, כלים וסטטוסים הושמטו/);
});

test('shared attachment export writes readable Markdown files with safe names', async () => {
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-conversation-share-'));
  const first = createSession('abc-123', 'שם / לא: בטוח?', [
    { id: 'u1', entryType: 'message', role: 'user', kind: 'prompt', timestamp: '2026-08-08T08:00:00.000Z', text: 'שאלה ראשונה' },
    { id: 'a1', entryType: 'message', role: 'assistant', kind: 'final', timestamp: '2026-08-08T08:01:00.000Z', text: 'תשובה ראשונה' },
  ]);
  const second = createSession('def-456', 'שיחה שנייה', [
    { id: 'u2', entryType: 'message', role: 'user', kind: 'prompt', timestamp: '2026-08-08T08:02:00.000Z', text: 'שאלה שנייה' },
  ]);

  try {
    const exports = await exportSharedConversations('developer', [first.id, second.id, first.id], null, {
      uploadRoot,
      exportedAt: new Date('2026-08-08T09:00:00.000Z'),
      loadSessionDetail: async (sessionId) => sessionId === first.id ? first : second,
    });

    assert.equal(exports.length, 2, 'duplicate session ids must be de-duplicated');
    assert.equal(exports[0].attachment.mimeType, 'text/markdown; charset=utf-8');
    assert.equal(exports[0].attachment.isImage, false);
    assert.match(exports[0].attachment.name, /^shared-conversation-/);
    assert.equal(/[\\/:*?"<>|]/u.test(exports[0].attachment.name), false);
    const firstContent = await fs.readFile(exports[0].attachment.path, 'utf8');
    assert.match(firstContent, /שאלה ראשונה/);
    assert.match(firstContent, /תשובה ראשונה/);
    assert.equal(exports[0].attachment.size, Buffer.byteLength(firstContent, 'utf8'));
  } finally {
    await fs.rm(uploadRoot, { recursive: true, force: true });
  }
});

test('failed multi-session export removes files already created', async () => {
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-conversation-share-failure-'));
  const first = createSession('first-session', 'ראשונה', [
    { id: 'u1', entryType: 'message', role: 'user', kind: 'prompt', timestamp: '2026-08-08T08:00:00.000Z', text: 'שאלה' },
  ]);

  try {
    await assert.rejects(
      exportSharedConversations('developer', [first.id, 'missing-session'], null, {
        uploadRoot,
        loadSessionDetail: async (sessionId) => {
          if (sessionId === first.id) return first;
          throw new Error('session missing');
        },
      }),
      /session missing/,
    );
    assert.deepEqual(await fs.readdir(uploadRoot), []);
  } finally {
    await fs.rm(uploadRoot, { recursive: true, force: true });
  }
});

test('current session cannot be exported into itself', async () => {
  await assert.rejects(
    exportSharedConversations('developer', ['same-session'], 'same-session', {
      uploadRoot: '/tmp/unused-conversation-share-root',
      loadSessionDetail: async () => {
        throw new Error('loader must not run');
      },
    }),
    /אי אפשר לצרף שיחה לעצמה/,
  );
});

test('file names stay bounded for very long titles', () => {
  const name = sanitizeSharedConversationFileName('כותרת '.repeat(80), 'session-with-id');
  assert.equal(name.endsWith('.md'), true);
  assert.equal(Buffer.byteLength(name, 'utf8') < 260, true);
});
