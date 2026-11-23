import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deleteSessionFlowMode,
  getSessionFlowMode,
  ingestSessionFlowDocumentFromText,
  normalizeFlowModeRecord,
  rebindSessionFlowMode,
  setSessionFlowMode,
} from './codexFlowMode.js';
import { extractFlowDocumentsFromText, normalizeFlowDocument, stripFlowDocumentBlocks } from '../shared/flowMode.js';

const validDocument = {
  schemaVersion: 1,
  id: 'demo',
  title: 'מערכת לדוגמה',
  direction: 'rtl',
  groups: [],
  nodes: [
    { id: 'ui', title: 'הממשק', kind: 'ui', ownership: 'repository', status: 'active' },
    { id: 'api', title: 'השרת', kind: 'api', ownership: 'repository', status: 'active' },
  ],
  edges: [{ id: 'ui-api', source: 'ui', target: 'api', label: 'בקשה', kind: 'request' }],
};

test('normalizes a canonical flow and rejects dangling edges', () => {
  const document = normalizeFlowDocument(validDocument);
  assert.equal(document.nodes.length, 2);
  assert.equal(document.edges[0].source, 'ui');
  assert.equal(document.nodes[0].flowRole, 'auto');
  assert.equal(document.layoutVersion, 0);
  assert.throws(() => normalizeFlowDocument({
    ...validDocument,
    edges: [{ source: 'missing', target: 'api' }],
  }), /שאינו קיים/);
});

test('extracts only valid fenced flow snapshots', () => {
  const documents = extractFlowDocumentsFromText([
    '```bina-flow',
    '{bad json',
    '```',
    '```bina-flow',
    JSON.stringify(validDocument),
    '```',
  ].join('\n'));
  assert.equal(documents.length, 1);
  assert.equal(documents[0].title, 'מערכת לדוגמה');
  const visible = stripFlowDocumentBlocks(`הסבר אנושי\n\n\`\`\`bina-flow\n${JSON.stringify(validDocument)}\n\`\`\``);
  assert.match(visible, /הסבר אנושי/);
  assert.doesNotMatch(visible, /"nodes"/);
});

test('promotes a legacy single-map record without losing its document', () => {
  const migrated = normalizeFlowModeRecord({
    profileId: 'legacy-profile',
    sessionKey: 'legacy-session',
    enabled: true,
    detail: 'balanced',
    brief: 'ישן אבל חשוב',
    document: validDocument,
    revision: 7,
    updatedAt: '2026-09-01T10:00:00.000Z',
    lastGeneratedAt: '2026-09-01T09:59:00.000Z',
    source: 'agent',
  });
  assert.equal(migrated?.maps.length, 1);
  assert.equal(migrated?.activeMapId, migrated?.maps[0].id);
  assert.equal(migrated?.maps[0].document.title, 'מערכת לדוגמה');
  assert.equal(migrated?.maps[0].revision, 7);
});

test('persists, ingests, conflicts and rebinds a session flow', async () => {
  const profileId = `flow-test-${Date.now()}`;
  const draftKey = 'draft:flow-test';
  const sessionKey = 'session-flow-test';
  await deleteSessionFlowMode(profileId, draftKey);
  await deleteSessionFlowMode(profileId, sessionKey);

  const enabled = await setSessionFlowMode(profileId, draftKey, {
    enabled: true,
    detail: 'deep',
    brief: 'הצג תשתיות',
    expectedRevision: 0,
    source: 'user',
  });
  assert.equal(enabled.revision, 1);

  const ingested = await ingestSessionFlowDocumentFromText(
    profileId,
    draftKey,
    `תשובה\n\`\`\`bina-flow\n${JSON.stringify(validDocument)}\n\`\`\``,
  );
  assert.equal(ingested?.document?.nodes.length, 2);
  await assert.rejects(() => setSessionFlowMode(profileId, draftKey, {
    enabled: true,
    expectedRevision: 1,
    source: 'user',
  }), /השתנתה במקום אחר/);

  const editedByUser = await setSessionFlowMode(profileId, draftKey, {
    enabled: true,
    document: { ...validDocument, title: 'עריכה חדשה בקנבס' },
    expectedRevision: ingested!.revision,
    source: 'user',
  });
  const staleAgentUpdate = await ingestSessionFlowDocumentFromText(
    profileId,
    draftKey,
    `תשובה ישנה\n\`\`\`bina-flow\n${JSON.stringify(validDocument)}\n\`\`\``,
    { mapId: ingested!.activeMapId!, mapRevision: ingested!.mapRevision - 1 },
  );
  assert.equal(staleAgentUpdate, null);
  assert.equal((await getSessionFlowMode(profileId, draftKey)).revision, editedByUser.revision);
  assert.equal((await getSessionFlowMode(profileId, draftKey)).document?.title, 'עריכה חדשה בקנבס');

  await rebindSessionFlowMode(profileId, draftKey, sessionKey);
  assert.equal((await getSessionFlowMode(profileId, draftKey)).document, null);
  assert.equal((await getSessionFlowMode(profileId, sessionKey)).document?.title, 'עריכה חדשה בקנבס');
  await deleteSessionFlowMode(profileId, sessionKey);
});

test('creates, switches, renames, duplicates and deletes independent maps', async () => {
  const profileId = `flow-library-${Date.now()}`;
  const sessionKey = 'session-library';
  await deleteSessionFlowMode(profileId, sessionKey);

  const first = await setSessionFlowMode(profileId, sessionKey, {
    enabled: true,
    document: { ...validDocument, title: 'מפת כניסה' },
    expectedRevision: 0,
    source: 'user',
  });
  assert.equal(first.maps.length, 1);
  assert.equal(first.mapRevision, 1);
  const firstMapId = first.activeMapId!;

  const second = await setSessionFlowMode(profileId, sessionKey, {
    operation: 'create',
    title: 'מפת רקע',
    expectedRevision: first.revision,
    source: 'user',
  });
  assert.equal(second.maps.length, 2);
  assert.equal(second.document?.title, 'מפת רקע');
  const secondMapId = second.activeMapId!;

  const renamed = await setSessionFlowMode(profileId, sessionKey, {
    operation: 'rename',
    mapId: secondMapId,
    title: 'מפת תהליכי רקע',
    expectedRevision: second.revision,
    expectedMapRevision: second.mapRevision,
    source: 'user',
  });
  assert.equal(renamed.document?.title, 'מפת תהליכי רקע');

  const duplicated = await setSessionFlowMode(profileId, sessionKey, {
    operation: 'duplicate',
    mapId: firstMapId,
    title: 'מפת כניסה — ניסוי',
    expectedRevision: renamed.revision,
    expectedMapRevision: renamed.maps.find((map) => map.id === firstMapId)?.revision,
    source: 'user',
  });
  assert.equal(duplicated.maps.length, 3);
  assert.equal(duplicated.document?.title, 'מפת כניסה — ניסוי');

  const selected = await setSessionFlowMode(profileId, sessionKey, {
    operation: 'select',
    mapId: firstMapId,
    expectedRevision: duplicated.revision,
    source: 'user',
  });
  assert.equal(selected.activeMapId, firstMapId);
  assert.equal(selected.document?.title, 'מפת כניסה');

  const removed = await setSessionFlowMode(profileId, sessionKey, {
    operation: 'delete',
    mapId: secondMapId,
    expectedRevision: selected.revision,
    expectedMapRevision: selected.maps.find((map) => map.id === secondMapId)?.revision,
    source: 'user',
  });
  assert.equal(removed.maps.length, 2);
  assert.equal(removed.maps.some((map) => map.id === secondMapId), false);
  await deleteSessionFlowMode(profileId, sessionKey);
});

test('agent output returns to its original map after the user switches maps', async () => {
  const profileId = `flow-target-${Date.now()}`;
  const sessionKey = 'session-target';
  await deleteSessionFlowMode(profileId, sessionKey);
  const first = await setSessionFlowMode(profileId, sessionKey, {
    enabled: true,
    document: { ...validDocument, title: 'מפת הסוכן' },
    expectedRevision: 0,
    source: 'user',
  });
  const target = { mapId: first.activeMapId!, mapRevision: first.mapRevision };
  const second = await setSessionFlowMode(profileId, sessionKey, {
    operation: 'create',
    title: 'מפת צפייה אחרת',
    expectedRevision: first.revision,
    source: 'user',
  });
  const ingested = await ingestSessionFlowDocumentFromText(
    profileId,
    sessionKey,
    `תשובה\n\`\`\`bina-flow\n${JSON.stringify({ ...validDocument, title: 'מפת הסוכן המעודכנת' })}\n\`\`\``,
    target,
  );
  assert.equal(ingested?.activeMapId, second.activeMapId);
  assert.equal(ingested?.document?.title, 'מפת צפייה אחרת');
  const switchedBack = await setSessionFlowMode(profileId, sessionKey, {
    operation: 'select',
    mapId: target.mapId,
    expectedRevision: ingested!.revision,
    source: 'user',
  });
  assert.equal(switchedBack.document?.title, 'מפת הסוכן המעודכנת');
  await deleteSessionFlowMode(profileId, sessionKey);
});

test('a deleted map cannot be recreated by a stale targeted save', async () => {
  const profileId = `flow-deleted-target-${Date.now()}`;
  const sessionKey = 'session-deleted-target';
  await deleteSessionFlowMode(profileId, sessionKey);
  const created = await setSessionFlowMode(profileId, sessionKey, {
    enabled: true,
    document: validDocument,
    expectedRevision: 0,
    source: 'user',
  });
  const deletedMapId = created.activeMapId!;
  const deleted = await setSessionFlowMode(profileId, sessionKey, {
    operation: 'delete',
    mapId: deletedMapId,
    expectedRevision: created.revision,
    expectedMapRevision: created.mapRevision,
    source: 'user',
  });
  assert.equal(deleted.maps.length, 0);
  await assert.rejects(() => setSessionFlowMode(profileId, sessionKey, {
    operation: 'save',
    enabled: true,
    mapId: deletedMapId,
    document: { ...validDocument, title: 'אסור להחזיר' },
    expectedRevision: deleted.revision,
    expectedMapRevision: created.mapRevision,
    source: 'agent',
  }), /כבר אינה קיימת/);
  assert.equal((await getSessionFlowMode(profileId, sessionKey)).maps.length, 0);
  await deleteSessionFlowMode(profileId, sessionKey);
});
