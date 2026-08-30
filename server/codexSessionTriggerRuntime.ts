import { createHash } from 'node:crypto';
import { CODEX_APP_CONFIG } from './config.js';
import { getAgentSessionDetail } from './agentService.js';
import { enqueueCodexQueueItem, type CodexQueueItem } from './codexQueue.js';
import { getSelectedPermissionModeId } from './providerPermissions.js';
import { getSessionInstruction } from './codexSessionInstructions.js';
import { getSessionContextSelection } from './codexSessionContextSelections.js';
import { getSessionBrowserMode } from './codexBrowserMode.js';
import { getSessionDesignMode, getSessionDesignModeRecord } from './codexDesignMode.js';
import { getSessionUxMode, getSessionUxModeRecord } from './codexUxMode.js';
import {
  getSessionPersonalChromeMode,
  getSessionPersonalChromeModeRecord,
} from './codexPersonalChromeMode.js';
import type { CodexSessionTrigger } from './codexSessionTriggers.js';

const SECRET_PATTERN = /\b(?:Bearer\s+[A-Za-z0-9._~+\/-]{8,}|(?:sk|key|token)-[A-Za-z0-9._-]{8,})\b/giu;
const HOST_PATH_PATTERN = /(?:\/(?:root|mnt\/hdd|home\/(?:developer|developer2))(?=\/|\s|$)(?:\/[^\s`"'<>]*)?)/gu;

export interface SessionTriggerPrompt {
  prompt: string;
  preview: string;
  payloadPreview: string | null;
}

export interface SessionTriggerInvocationResult {
  item: CodexQueueItem;
  prompt: SessionTriggerPrompt;
}

function optionalText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function sanitizeDelegatedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(SECRET_PATTERN, '[SECRET REDACTED]')
    .replace(HOST_PATH_PATTERN, '[HOST PATH REDACTED]')
    .replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim();
  if (!normalized) return null;
  return normalized.length > maximum
    ? `${normalized.slice(0, maximum - 1).trimEnd()}\n…`
    : normalized;
}

function serializeTriggerPayload(value: unknown, limit = 12_000): string | null {
  if (value === undefined) return null;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return sanitizeDelegatedText(text, limit);
  } catch {
    return null;
  }
}

export function buildSessionTriggerPrompt(triggerLabel: string, body: any): SessionTriggerPrompt {
  const primaryText = typeof body?.prompt === 'string'
    ? body.prompt
    : typeof body?.message === 'string'
      ? body.message
      : typeof body?.content === 'string'
        ? body.content
        : '';
  const source = optionalText(body?.source, 160) || optionalText(body?.service, 160);
  const payloadText = serializeTriggerPayload(body?.payload ?? body?.data ?? body?.details);
  const trimmedPrimary = sanitizeDelegatedText(primaryText, 60_000);
  if (!trimmedPrimary && !payloadText) {
    throw new Error('Trigger request must include content, message, prompt, or payload');
  }

  return {
    prompt: [
      'הופעל טריגר חיצוני עבור הסשן הזה.',
      `שם הטריגר: ${triggerLabel}`,
      source ? `מקור הטריגר: ${source}` : null,
      trimmedPrimary ? `תוכן המשימה:\n${trimmedPrimary}` : null,
      payloadText ? `Payload נלווה:\n${payloadText}` : null,
      'טפל בזה כמשימה חדשה בתוך אותו סשן, בלי לאבד את ההקשר הקיים של השיחה.',
    ].filter(Boolean).join('\n\n'),
    preview: `טריגר · ${triggerLabel}`,
    payloadPreview: trimmedPrimary || payloadText || null,
  };
}

export async function enqueueSessionTriggerInvocation(input: {
  trigger: CodexSessionTrigger;
  body: any;
  clientRequestId?: string | null;
}): Promise<SessionTriggerInvocationResult> {
  const configuredProfile = CODEX_APP_CONFIG.profiles.find((profile) => profile.id === input.trigger.profileId);
  if (!configuredProfile || configuredProfile.internalOnly || configuredProfile.mode === 'support') {
    throw new Error('The selected profile was not found');
  }
  const model = optionalText(input.body?.model, 240);
  const reasoningEffort = optionalText(input.body?.reasoningEffort, 80);
  const permissionModeId = optionalText(input.body?.permissionModeId, 160)
    || await getSelectedPermissionModeId(configuredProfile);
  const detail = await getAgentSessionDetail(input.trigger.sessionId, input.trigger.profileId, { tail: 1 });
  const [
    sessionInstruction,
    sessionContextSelection,
    browserMode,
    designModeRecord,
    uxModeRecord,
    personalChromeModeRecord,
  ] = await Promise.all([
    getSessionInstruction(input.trigger.profileId, input.trigger.sessionId),
    getSessionContextSelection(input.trigger.profileId, input.trigger.sessionId),
    getSessionBrowserMode(input.trigger.profileId, input.trigger.sessionId),
    getSessionDesignModeRecord(input.trigger.profileId, input.trigger.sessionId),
    getSessionUxModeRecord(input.trigger.profileId, input.trigger.sessionId),
    getSessionPersonalChromeModeRecord(input.trigger.profileId, input.trigger.sessionId),
  ]);
  const [designMode, uxMode, personalChromeMode] = await Promise.all([
    designModeRecord ? getSessionDesignMode(input.trigger.profileId, input.trigger.sessionId) : null,
    uxModeRecord ? getSessionUxMode(input.trigger.profileId, input.trigger.sessionId) : null,
    personalChromeModeRecord
      ? getSessionPersonalChromeMode(input.trigger.profileId, input.trigger.sessionId)
      : null,
  ]);
  const prompt = buildSessionTriggerPrompt(input.trigger.label, input.body);
  const item = await enqueueCodexQueueItem({
    profileId: input.trigger.profileId,
    queueKey: input.trigger.sessionId,
    clientRequestId: optionalText(input.clientRequestId, 300),
    sessionId: input.trigger.sessionId,
    cwd: detail.cwd || configuredProfile.workspaceCwd,
    model,
    reasoningEffort,
    permissionModeId,
    prompt: prompt.prompt,
    promptPreview: prompt.preview,
    sessionInstruction: sessionInstruction || undefined,
    actionRestriction: sessionContextSelection.actionRestriction,
    browserMode,
    designMode,
    uxMode,
    personalChromeMode,
  });
  return { item, prompt };
}

export function digestSessionTriggerInvocation(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export function buildSessionTriggerClientRequestId(triggerId: string, value: unknown): string | null {
  const normalizedTriggerId = optionalText(triggerId, 160);
  const normalizedValue = optionalText(value, 2_000);
  if (!normalizedTriggerId || !normalizedValue) {
    return null;
  }

  return `session-trigger:${normalizedTriggerId}:${digestSessionTriggerInvocation(normalizedValue)}`;
}
