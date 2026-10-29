import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CodexApiCredentialProfile {
  id: string;
  codexHome: string;
}

export interface CodexApiCredentialMetadata {
  id: string;
  label: string;
  maskedSuffix: string;
  source: 'saved' | 'seed';
  createdAt: string;
}

/** Internal only: never serialize this result into an HTTP response or a log. */
export interface ResolvedCodexApiCredential extends CodexApiCredentialMetadata {
  apiKey: string;
}

export class CodexApiCredentialError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CodexApiCredentialError';
  }
}

interface SavedCredential {
  id: string;
  label: string;
  apiKey: string;
  createdAt: string;
}

interface ProfileCredentials {
  profileId: string;
  codexHome: string;
  credentials: SavedCredential[];
  disabledSeedIds: string[];
}

interface Registry {
  version: 1;
  profiles: ProfileCredentials[];
}

const MAX_FILE_BYTES = 4 * 1_024 * 1_024;
const MAX_SAVED_PER_PROFILE = 100;
const registryOperations = new Map<string, Promise<unknown>>();
const ID_PATTERN = /^(?:saved-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|seed-[a-f0-9]{24})$/u;

function fail(code: string, message: string): never {
  // Do not attach causes: filesystem/JSON errors can contain secret bytes.
  throw new CodexApiCredentialError(code, message);
}

function registryFile(): string {
  return path.resolve(process.env.CODE_AI_OPENAI_CREDENTIALS_FILE?.trim()
    || path.join(os.homedir(), '.code-ai-private', 'openai-credentials.json'));
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_label', 'A credential label is required.');
  const label = value.trim();
  if (!label || label.length > 100 || /[\u0000-\u001f\u007f]/u.test(label)
    || /sk-[a-zA-Z0-9_-]{12,}/u.test(label)) {
    fail('invalid_label', 'Use a label of 1 to 100 characters without secret keys or control characters.');
  }
  return label;
}

function normalizeApiKey(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_api_key', 'An OpenAI API key is required.');
  const apiKey = value.trim();
  if (apiKey.length < 20 || apiKey.length > 1_024 || !/^sk-[a-zA-Z0-9_-]+$/u.test(apiKey)) {
    fail('invalid_api_key', 'The OpenAI API key format is invalid.');
  }
  return apiKey;
}

function validateId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('invalid_credential_id', 'The credential identifier is invalid.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateCreatedAt(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    fail('invalid_registry', 'The private credential registry is invalid.');
  }
}

async function profileBinding(profile: CodexApiCredentialProfile): Promise<{ profileId: string; codexHome: string }> {
  if (!profile || typeof profile.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(profile.id)
    || typeof profile.codexHome !== 'string' || !path.isAbsolute(profile.codexHome)
    || profile.codexHome.includes('\0')) {
    fail('invalid_profile', 'The credential profile is invalid.');
  }
  let codexHome = path.resolve(profile.codexHome);
  try {
    codexHome = await fs.realpath(codexHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      fail('credential_storage_unavailable', 'Private credential storage is unavailable.');
    }
  }
  return { profileId: profile.id, codexHome };
}

/** A single writer per registry prevents lost updates from concurrent HTTP calls. */
async function withRegistry<T>(operation: (file: string) => Promise<T>): Promise<T> {
  const file = registryFile();
  const previous = registryOperations.get(file) || Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => operation(file));
  registryOperations.set(file, pending);
  try {
    return await pending;
  } finally {
    if (registryOperations.get(file) === pending) registryOperations.delete(file);
  }
}

async function readPrivateJson(file: string, optional: boolean): Promise<{ value: unknown; modifiedAt: string } | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (stat.mode & 0o077) !== 0) {
      fail('insecure_credential_storage', 'Credential files must be private regular files.');
    }
    const raw = await handle.readFile('utf8');
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      fail('invalid_registry', 'The private credential registry is invalid.');
    }
    return { value, modifiedAt: stat.mtime.toISOString() };
  } catch (error) {
    if (error instanceof CodexApiCredentialError) throw error;
    if (optional && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    return fail('credential_storage_unavailable', 'Private credential storage is unavailable.');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readRegistry(file: string): Promise<Registry> {
  const parsed = await readPrivateJson(file, true);
  if (!parsed) return { version: 1, profiles: [] };
  const value = parsed.value;
  try {
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.profiles)
      || value.profiles.length > 1_000) throw new Error();
    const profiles: ProfileCredentials[] = [];
    const bindings = new Set<string>();
    for (const profile of value.profiles) {
      if (!isRecord(profile) || typeof profile.profileId !== 'string' || typeof profile.codexHome !== 'string'
        || !path.isAbsolute(profile.codexHome) || !Array.isArray(profile.credentials)
        || profile.credentials.length > MAX_SAVED_PER_PROFILE || !Array.isArray(profile.disabledSeedIds)
        || profile.disabledSeedIds.length > 1_000) throw new Error();
      const binding = JSON.stringify([profile.profileId, profile.codexHome]);
      if (bindings.has(binding)) throw new Error();
      bindings.add(binding);
      const ids = new Set<string>();
      const credentials: SavedCredential[] = [];
      for (const credential of profile.credentials) {
        if (!isRecord(credential)) throw new Error();
        validateId(credential.id);
        if (!credential.id.startsWith('saved-') || ids.has(credential.id)) throw new Error();
        ids.add(credential.id);
        validateCreatedAt(credential.createdAt);
        credentials.push({
          id: credential.id,
          label: normalizeLabel(credential.label),
          apiKey: normalizeApiKey(credential.apiKey),
          createdAt: credential.createdAt,
        });
      }
      const disabledSeedIds = profile.disabledSeedIds.map((id) => {
        validateId(id);
        if (!id.startsWith('seed-')) throw new Error();
        return id;
      });
      profiles.push({ profileId: profile.profileId, codexHome: profile.codexHome, credentials, disabledSeedIds });
    }
    return { version: 1, profiles };
  } catch {
    fail('invalid_registry', 'The private credential registry is invalid.');
  }
}

async function writeRegistry(file: string, registry: Registry): Promise<void> {
  const parent = path.dirname(file);
  let temporaryFile: string | undefined;
  try {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(parent);
    // Refuse to chmod an arbitrary shared directory selected by configuration.
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) {
      fail('insecure_credential_storage', 'Credential storage requires a private directory.');
    }
    temporaryFile = path.join(parent, `.openai-credentials-${randomUUID()}.tmp`);
    const handle = await fs.open(temporaryFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(registry)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryFile, file);
    temporaryFile = undefined;
    const directoryHandle = await fs.open(parent, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (error instanceof CodexApiCredentialError) throw error;
    fail('credential_storage_unavailable', 'Private credential storage is unavailable.');
  } finally {
    if (temporaryFile) await fs.unlink(temporaryFile).catch(() => undefined);
  }
}

function findProfile(registry: Registry, binding: { profileId: string; codexHome: string }, create = false): ProfileCredentials | undefined {
  let profile = registry.profiles.find((entry) => entry.profileId === binding.profileId && entry.codexHome === binding.codexHome);
  if (!profile && create) {
    if (registry.profiles.length >= 1_000) fail('credential_limit', 'The saved credential limit has been reached.');
    profile = { ...binding, credentials: [], disabledSeedIds: [] };
    registry.profiles.push(profile);
  }
  return profile;
}

async function readSeeds(profile: CodexApiCredentialProfile): Promise<ResolvedCodexApiCredential[]> {
  const seedFile = process.env.CODE_AI_OPENAI_CREDENTIALS_SEED_FILE?.trim();
  const allowedProfiles = (process.env.CODE_AI_OPENAI_CREDENTIALS_SEED_PROFILES || '').split(',').map((id) => id.trim()).filter(Boolean);
  // Both a source file and explicit profile grants are required. '*' grants every profile on this host.
  if (!seedFile || !allowedProfiles.some((id) => id === '*' || id === profile.id)) return [];
  const parsed = await readPrivateJson(path.resolve(seedFile), false);
  if (!parsed || !isRecord(parsed.value) || !Array.isArray(parsed.value.accounts) || parsed.value.accounts.length > 256) {
    fail('invalid_seed', 'The configured credential source is invalid.');
  }
  try {
    const ids = new Set<string>();
    return parsed.value.accounts.map((account: unknown) => {
      if (!isRecord(account) || typeof account.accountId !== 'string' || !account.accountId.trim()
        || account.accountId.length > 256) throw new Error();
      const id = `seed-${createHash('sha256').update(account.accountId).digest('hex').slice(0, 24)}`;
      if (ids.has(id)) throw new Error();
      ids.add(id);
      return {
        id,
        label: normalizeLabel(account.label),
        apiKey: normalizeApiKey(account.apiKey),
        maskedSuffix: maskKey(normalizeApiKey(account.apiKey)),
        source: 'seed' as const,
        createdAt: parsed.modifiedAt,
      };
    });
  } catch {
    fail('invalid_seed', 'The configured credential source is invalid.');
  }
}

function maskKey(apiKey: string): string {
  return `••••${apiKey.slice(-4)}`;
}

function publicMetadata(credential: ResolvedCodexApiCredential): CodexApiCredentialMetadata {
  return {
    id: credential.id,
    label: credential.label,
    maskedSuffix: credential.maskedSuffix,
    source: credential.source,
    createdAt: credential.createdAt,
  };
}

function savedMetadata(credential: SavedCredential): ResolvedCodexApiCredential {
  return { ...credential, source: 'saved', maskedSuffix: maskKey(credential.apiKey) };
}

export async function listCodexApiCredentials(profile: CodexApiCredentialProfile): Promise<CodexApiCredentialMetadata[]> {
  const binding = await profileBinding(profile);
  return withRegistry(async (file) => {
    const saved = findProfile(await readRegistry(file), binding);
    const seeds = (await readSeeds(profile)).filter((entry) => !saved?.disabledSeedIds.includes(entry.id));
    return [...seeds, ...(saved?.credentials || []).map(savedMetadata)].map(publicMetadata);
  });
}

export async function saveCodexApiCredential(
  profile: CodexApiCredentialProfile,
  input: { label: string; apiKey: string },
): Promise<CodexApiCredentialMetadata> {
  const binding = await profileBinding(profile);
  const label = normalizeLabel(input?.label);
  const apiKey = normalizeApiKey(input?.apiKey);
  return withRegistry(async (file) => {
    const registry = await readRegistry(file);
    const saved = findProfile(registry, binding, true)!;
    let credential = saved.credentials.find((entry) => entry.apiKey === apiKey);
    if (credential) {
      credential.label = label;
    } else {
      if (saved.credentials.length >= MAX_SAVED_PER_PROFILE) fail('credential_limit', 'The saved credential limit has been reached.');
      credential = { id: `saved-${randomUUID()}`, label, apiKey, createdAt: new Date().toISOString() };
      saved.credentials.push(credential);
    }
    await writeRegistry(file, registry);
    return publicMetadata(savedMetadata(credential));
  });
}

/** Seed removal records a profile-local tombstone without modifying the source. */
export async function deleteCodexApiCredential(profile: CodexApiCredentialProfile, credentialId: string): Promise<boolean> {
  validateId(credentialId);
  const binding = await profileBinding(profile);
  return withRegistry(async (file) => {
    const registry = await readRegistry(file);
    const saved = findProfile(registry, binding, credentialId.startsWith('seed-'));
    if (!saved) return false;
    if (credentialId.startsWith('seed-')) {
      if (saved.disabledSeedIds.includes(credentialId) || !(await readSeeds(profile)).some((entry) => entry.id === credentialId)) return false;
      saved.disabledSeedIds.push(credentialId);
    } else {
      const index = saved.credentials.findIndex((entry) => entry.id === credentialId);
      if (index === -1) return false;
      saved.credentials.splice(index, 1);
    }
    await writeRegistry(file, registry);
    return true;
  });
}

export async function resolveCodexApiCredential(profile: CodexApiCredentialProfile, credentialId: string): Promise<ResolvedCodexApiCredential> {
  validateId(credentialId);
  const binding = await profileBinding(profile);
  return withRegistry(async (file) => {
    const saved = findProfile(await readRegistry(file), binding);
    const credential = credentialId.startsWith('saved-')
      ? saved?.credentials.find((entry) => entry.id === credentialId)
      : undefined;
    if (credential) return savedMetadata(credential);
    if (!saved?.disabledSeedIds.includes(credentialId)) {
      const seed = (await readSeeds(profile)).find((entry) => entry.id === credentialId);
      if (seed) return seed;
    }
    fail('credential_not_found', 'The selected credential is unavailable for this profile.');
  });
}
