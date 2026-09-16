import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deleteSessionFlowMode,
  getSessionFlowMode,
  ingestSessionFlowDocumentFromText,
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
    ingested!.revision,
  );
  assert.equal(staleAgentUpdate, null);
  assert.equal((await getSessionFlowMode(profileId, draftKey)).revision, editedByUser.revision);
  assert.equal((await getSessionFlowMode(profileId, draftKey)).document?.title, 'עריכה חדשה בקנבס');

  await rebindSessionFlowMode(profileId, draftKey, sessionKey);
  assert.equal((await getSessionFlowMode(profileId, draftKey)).document, null);
  assert.equal((await getSessionFlowMode(profileId, sessionKey)).document?.title, 'עריכה חדשה בקנבס');
  await deleteSessionFlowMode(profileId, sessionKey);
});
