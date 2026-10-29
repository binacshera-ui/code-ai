import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  CodexApiCredentialError,
  deleteCodexApiCredential,
  listCodexApiCredentials,
  resolveCodexApiCredential,
  saveCodexApiCredential,
} from './codexApiCredentials.js';

const FAKE_KEY_A = ('sk-' + 'test-only-fixture-aaaaaaaaaaaa1111');
const FAKE_KEY_B = ('sk-' + 'test-only-fixture-bbbbbbbbbbbb2222');
const ENV_NAMES = [
  'CODE_AI_OPENAI_CREDENTIALS_FILE',
  'CODE_AI_OPENAI_CREDENTIALS_SEED_FILE',
  'CODE_AI_OPENAI_CREDENTIALS_SEED_PROFILES',
] as const;

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-api-credentials-'));
  const previous = ENV_NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of ENV_NAMES) delete process.env[name];
  const file = path.join(root, 'private', 'registry.json');
  const seedFile = path.join(root, 'seed.json');
  process.env.CODE_AI_OPENAI_CREDENTIALS_FILE = file;
  t.after(async () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const profile = { id: 'developer', codexHome: path.join(root, 'home', '.codex') };
  const other = { id: 'developer2', codexHome: path.join(root, 'other-home', '.codex') };
  async function seed() {
    const contents = JSON.stringify({
      schema: 'openai-organizations-test',
      accounts: [
        { accountId: 'organization-test-a', label: 'ארגון א', apiKey: FAKE_KEY_A },
        { accountId: 'organization-test-b', label: 'ארגון ב', apiKey: FAKE_KEY_B },
      ],
    });
    await fs.writeFile(seedFile, contents, { mode: 0o600 });
    process.env.CODE_AI_OPENAI_CREDENTIALS_SEED_FILE = seedFile;
    return contents;
  }
  return { root, file, seedFile, profile, other, seed };
}

function expectSafeError(code: string, forbidden = FAKE_KEY_A) {
  return (error: unknown) => {
    assert.ok(error instanceof CodexApiCredentialError);
    assert.equal(error.code, code);
    assert.ok(!String(error).includes(forbidden));
    assert.equal('cause' in error, false);
    return true;
  };
}

test('save/list expose metadata only while internal resolution reads a private persisted key', async (t) => {
  const { file, profile } = await fixture(t);
  assert.deepEqual(await listCodexApiCredentials(profile), []);
  const metadata = await saveCodexApiCredential(profile, { label: '  חשבון ראשון  ', apiKey: ` ${FAKE_KEY_A}\n` });
  assert.equal(metadata.label, 'חשבון ראשון');
  assert.equal(metadata.maskedSuffix, '••••1111');
  assert.equal(metadata.source, 'saved');
  assert.match(metadata.id, /^saved-/u);
  assert.ok(Number.isFinite(Date.parse(metadata.createdAt)));
  const listed = await listCodexApiCredentials(profile);
  assert.deepEqual(listed, [metadata]);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['createdAt', 'id', 'label', 'maskedSuffix', 'source']);
  assert.ok(!JSON.stringify(metadata).includes(FAKE_KEY_A));
  assert.equal((await resolveCodexApiCredential(profile, metadata.id)).apiKey, FAKE_KEY_A);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
});

test('saving the same key updates its label without making duplicate credentials', async (t) => {
  const { profile } = await fixture(t);
  const original = await saveCodexApiCredential(profile, { label: 'Original', apiKey: FAKE_KEY_A });
  const changed = await saveCodexApiCredential(profile, { label: 'Updated', apiKey: FAKE_KEY_A });
  assert.equal(changed.id, original.id);
  assert.equal(changed.createdAt, original.createdAt);
  assert.equal(changed.label, 'Updated');
  assert.deepEqual(await listCodexApiCredentials(profile), [changed]);
});

test('saved credentials require both the profile ID and canonical home binding', async (t) => {
  const { root, profile, other } = await fixture(t);
  await fs.mkdir(profile.codexHome, { recursive: true });
  const alias = path.join(root, 'codex-alias');
  await fs.symlink(profile.codexHome, alias);
  const saved = await saveCodexApiCredential(profile, { label: 'Private', apiKey: FAKE_KEY_A });
  assert.equal((await resolveCodexApiCredential({ ...profile, codexHome: alias }, saved.id)).apiKey, FAKE_KEY_A);
  for (const inaccessible of [other, { ...profile, codexHome: other.codexHome }, { ...profile, id: other.id }]) {
    assert.deepEqual(await listCodexApiCredentials(inaccessible), []);
    await assert.rejects(resolveCodexApiCredential(inaccessible, saved.id), expectSafeError('credential_not_found'));
    assert.equal(await deleteCodexApiCredential(inaccessible, saved.id), false);
  }
});

test('concurrent saves and deletions retain unrelated profile data', async (t) => {
  const { profile, other } = await fixture(t);
  const items = await Promise.all(Array.from({ length: 20 }, (_, index) => saveCodexApiCredential(
    index % 2 ? other : profile,
    { label: `Account ${index}`, apiKey: `${FAKE_KEY_A}${index}` },
  )));
  assert.equal((await listCodexApiCredentials(profile)).length, 10);
  assert.equal((await listCodexApiCredentials(other)).length, 10);
  await Promise.all(items.map((item, index) => deleteCodexApiCredential(index % 2 ? other : profile, item.id)));
  assert.deepEqual(await listCodexApiCredentials(profile), []);
  assert.deepEqual(await listCodexApiCredentials(other), []);
});

test('seed keys require an explicit host-local source and profile grant', async (t) => {
  const { profile, other, seed } = await fixture(t);
  await seed();
  assert.deepEqual(await listCodexApiCredentials(profile), []);
  process.env.CODE_AI_OPENAI_CREDENTIALS_SEED_PROFILES = '  developer  ';
  const listed = await listCodexApiCredentials(profile);
  assert.equal(listed.length, 2);
  assert.equal(listed[0].source, 'seed');
  assert.equal(listed[0].label, 'ארגון א');
  assert.equal(listed[0].maskedSuffix, '••••1111');
  assert.match(listed[0].id, /^seed-[a-f0-9]{24}$/u);
  assert.ok(!JSON.stringify(listed).includes(FAKE_KEY_A));
  assert.equal((await resolveCodexApiCredential(profile, listed[0].id)).apiKey, FAKE_KEY_A);
  assert.deepEqual(await listCodexApiCredentials(other), []);
  await assert.rejects(resolveCodexApiCredential(other, listed[0].id), expectSafeError('credential_not_found'));
  process.env.CODE_AI_OPENAI_CREDENTIALS_SEED_PROFILES = '*';
  assert.equal((await listCodexApiCredentials(other)).length, 2);
});

test('deleting a seed creates a profile-local tombstone and preserves the source', async (t) => {
  const { profile, other, seed, seedFile } = await fixture(t);
  const originalSource = await seed();
  process.env.CODE_AI_OPENAI_CREDENTIALS_SEED_PROFILES = 'developer,developer2';
  const [removed, retained] = await listCodexApiCredentials(profile);
  assert.equal(await deleteCodexApiCredential(profile, removed.id), true);
  assert.equal(await deleteCodexApiCredential(profile, removed.id), false);
  assert.deepEqual(await listCodexApiCredentials(profile), [retained]);
  assert.equal((await listCodexApiCredentials(other)).length, 2);
  await assert.rejects(resolveCodexApiCredential(profile, removed.id), expectSafeError('credential_not_found'));
  assert.equal(await fs.readFile(seedFile, 'utf8'), originalSource);
});

test('deletion is idempotent and removes saved secrets from subsequent resolution', async (t) => {
  const { profile } = await fixture(t);
  const metadata = await saveCodexApiCredential(profile, { label: 'Temporary', apiKey: FAKE_KEY_A });
  assert.equal(await deleteCodexApiCredential(profile, metadata.id), true);
  assert.equal(await deleteCodexApiCredential(profile, metadata.id), false);
  await assert.rejects(resolveCodexApiCredential(profile, metadata.id), expectSafeError('credential_not_found'));
});

test('invalid identifiers, labels and keys use static errors without echoing inputs', async (t) => {
  const { profile } = await fixture(t);
  await assert.rejects(saveCodexApiCredential(profile, { label: FAKE_KEY_A, apiKey: FAKE_KEY_A }), expectSafeError('invalid_label'));
  await assert.rejects(saveCodexApiCredential(profile, { label: 'x'.repeat(101), apiKey: FAKE_KEY_A }), expectSafeError('invalid_label'));
  await assert.rejects(saveCodexApiCredential(profile, { label: 'Valid', apiKey: `${FAKE_KEY_A} bad` }), expectSafeError('invalid_api_key'));
  await assert.rejects(resolveCodexApiCredential(profile, FAKE_KEY_A), expectSafeError('invalid_credential_id'));
  await assert.rejects(deleteCodexApiCredential(profile, '../auth.json'), expectSafeError('invalid_credential_id'));
  await assert.rejects(listCodexApiCredentials({ ...profile, id: FAKE_KEY_A + '\n' }), expectSafeError('invalid_profile'));
});

test('malformed registry and seed JSON never expose parser excerpts with secret bytes', async (t) => {
  const { profile, file, seedFile } = await fixture(t);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `{"apiKey":"${FAKE_KEY_A}" BROKEN`, { mode: 0o600 });
  await assert.rejects(listCodexApiCredentials(profile), expectSafeError('invalid_registry'));
  await fs.unlink(file);
  await fs.writeFile(seedFile, `{"apiKey":"${FAKE_KEY_A}" BROKEN`, { mode: 0o600 });
  process.env.CODE_AI_OPENAI_CREDENTIALS_SEED_FILE = seedFile;
  process.env.CODE_AI_OPENAI_CREDENTIALS_SEED_PROFILES = profile.id;
  await assert.rejects(listCodexApiCredentials(profile), expectSafeError('invalid_registry'));
});

test('registry storage refuses broad permissions and symlinked files', async (t) => {
  const { root, profile, file } = await fixture(t);
  const metadata = await saveCodexApiCredential(profile, { label: 'Private', apiKey: FAKE_KEY_A });
  await fs.chmod(file, 0o644);
  await assert.rejects(resolveCodexApiCredential(profile, metadata.id), expectSafeError('insecure_credential_storage'));
  await fs.chmod(file, 0o600);
  const destination = path.join(root, 'destination.json');
  await fs.rename(file, destination);
  await fs.symlink(destination, file);
  await assert.rejects(listCodexApiCredentials(profile), expectSafeError('credential_storage_unavailable'));
});

test('saving refuses a shared or symlinked parent without changing its permissions', async (t) => {
  const { root, profile, file } = await fixture(t);
  await fs.mkdir(path.dirname(file), { mode: 0o755 });
  await fs.chmod(path.dirname(file), 0o755);
  await assert.rejects(saveCodexApiCredential(profile, { label: 'Private', apiKey: FAKE_KEY_A }), expectSafeError('insecure_credential_storage'));
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o755);
  await fs.rmdir(path.dirname(file));
  await fs.symlink(root, path.dirname(file));
  await assert.rejects(saveCodexApiCredential(profile, { label: 'Private', apiKey: FAKE_KEY_A }), expectSafeError('insecure_credential_storage'));
});
