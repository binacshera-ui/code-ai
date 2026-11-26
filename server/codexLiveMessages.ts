import path from 'node:path';
import { CODEX_APP_CONFIG } from './config.js';
import { createCodexLiveInputService, CodexLiveInputError } from './codexLiveInput.mjs';
import { createCodexLiveInputStore } from './codexLiveInputStore.mjs';
import { connectCodexLiveInput } from './codexLiveInputNative.mjs';

/** Native Codex 0.171 owns delivery, history and tool execution. This store is
 * only an idempotency receipt journal: it never schedules or executes a job. */
let service: Promise<ReturnType<typeof createCodexLiveInputService>> | null = null;
let closeStore: (() => unknown) | null = null;

export function codexLiveInputCapability(profileId: string) {
  const profile = CODEX_APP_CONFIG.profiles.find(item => item.id === profileId);
  const owners = new Set((process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES || '')
    .split(',').map(value => value.trim()).filter(Boolean));
  return { supported: profile?.provider === 'codex' && owners.has(profileId), protocol: 'steer-context-v1' as const };
}

async function getService() {
  if (!service) service = (async () => {
    const store = await createCodexLiveInputStore({ filename: path.join(CODEX_APP_CONFIG.storageRoot, 'live-inputs.sqlite') });
    closeStore = () => store.close();
    return createCodexLiveInputService({ store, connect: connectCodexLiveInput });
  })().catch(error => { service = null; throw error; });
  return service;
}

export async function appendCodexLiveMessage(request: {
  profileId: string; sessionId: string; clientRequestId: string;
  input: Array<{ type: 'text'; text: string } | { type: 'localImage'; path: string }>;
  contextText: string;
}) {
  const profile = CODEX_APP_CONFIG.profiles.find(item => item.id === request.profileId);
  if (!profile || !codexLiveInputCapability(profile.id).supported) {
    throw new CodexLiveInputError('LIVE_INPUT_UNAVAILABLE', 'השרת אינו תומך כרגע בצירוף הודעה לריצה הפעילה. ההודעה לא נוספה לתור.', 503);
  }
  const owner = await getService();
  // No model, permission, cwd or effort override is supplied. Existing quota
  // admission/cancellation and the inference fence still govern the active run.
  return owner.append({ ...request, connectionOptions: { codexHome: profile.codexHome } });
}

export async function closeCodexLiveMessages() {
  if (service) await service;
  await closeStore?.();
  service = null; closeStore = null;
}
