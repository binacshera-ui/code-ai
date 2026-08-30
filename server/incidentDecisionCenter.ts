import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';
import { enqueueCodexQueueItem } from './codexQueue.js';

export type IncidentCaseStatus =
  | 'open'
  | 'waiting_investigator'
  | 'waiting_operator'
  | 'needs_more_evidence'
  | 'approved_for_execution'
  | 'execution_in_progress'
  | 'verification_in_progress'
  | 'execution_failed'
  | 'needs_additional_decision'
  | 'waiting_completion_confirmation'
  | 'rejected'
  | 'reopened'
  | 'completed';

export type IncidentCaseMessageAuthor = 'system' | 'investigator' | 'operator';

export interface IncidentCaseMessage {
  id: string;
  createdAt: string;
  author: IncidentCaseMessageAuthor;
  kind: string;
  text: string;
  payload?: Record<string, unknown> | null;
}

export interface IncidentCaseRecord {
  caseId: string;
  createdAt: string;
  updatedAt: string;
  status: IncidentCaseStatus;
  title: string;
  summary: string;
  failureTicketId: string | null;
  threadId: string | null;
  messageId: string | null;
  runId: string | null;
  investigatorSessionId: string | null;
  investigatorProfileId: string | null;
  lastWakeAt: string | null;
  lastWakeReason: string | null;
  lastWakeQueueItemId: string | null;
  operatorDecision: string | null;
  resolutionSummary: string | null;
  completedAt: string | null;
  metadata: Record<string, unknown>;
  messages: IncidentCaseMessage[];
}

const INCIDENT_CENTER_ROOT = path.join(CODEX_APP_CONFIG.storageRoot, 'incident-center');
const INCIDENT_CONTEXT_ROOT = path.join(INCIDENT_CENTER_ROOT, 'context');
const FAILURE_HANDLING_BASE_URL = String(
  process.env.CODEX_INCIDENT_FAILURE_URL ||
  process.env.BC2_FAILURE_URL ||
  `http://127.0.0.1:${process.env.BC2_FAILURE_PORT || 8210}`
).replace(/\/+$/g, '');
const FAILURE_HANDLING_AUTH_TOKEN = String(
  process.env.CODEX_INCIDENT_FAILURE_AUTH_TOKEN ||
  process.env.BC2_FAILURE_AUTH_TOKEN ||
  ''
).trim();
const DEFAULT_INCIDENT_PROFILE_ID = String(
  process.env.CODEX_INCIDENT_PROFILE_ID ||
  process.env.BC2_FAILURE_INCIDENT_PROFILE_ID ||
  CODEX_APP_CONFIG.defaultProfileId ||
  ''
).trim();
const DEFAULT_INCIDENT_SESSION_ID = String(
  process.env.CODEX_INCIDENT_SESSION_ID ||
  process.env.BC2_FAILURE_INCIDENT_SESSION_ID ||
  ''
).trim();

function nowIso(): string {
  return new Date().toISOString();
}

function cleanText(value: unknown): string {
  return String(value || '').trim();
}

function failureHeaders() {
  const authToken = FAILURE_HANDLING_AUTH_TOKEN
    ? (FAILURE_HANDLING_AUTH_TOKEN.startsWith('Bearer ')
      ? FAILURE_HANDLING_AUTH_TOKEN
      : `Bearer ${FAILURE_HANDLING_AUTH_TOKEN}`)
    : null;
  return authToken
    ? { Authorization: authToken }
    : {};
}

async function requestJson(pathname: string, options: RequestInit = {}) {
  const response = await fetch(`${FAILURE_HANDLING_BASE_URL}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...failureHeaders(),
      ...(options.headers || {}),
    },
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : { error: await response.text() };
  if (!response.ok) {
    throw new Error(String(body?.error || body?.message || response.statusText || 'incident_request_failed'));
  }
  return body;
}

function mapStatus(value: unknown): IncidentCaseStatus {
  const normalized = cleanText(value).toLowerCase();
  switch (normalized) {
    case 'waiting_investigator':
    case 'open':
      return 'waiting_investigator';
    case 'waiting_operator':
      return 'waiting_operator';
    case 'needs_more_evidence':
    case 'missing_evidence':
    case 'insufficient_evidence':
      return 'needs_more_evidence';
    case 'approved_for_execution':
      return 'approved_for_execution';
    case 'execution_in_progress':
      return 'execution_in_progress';
    case 'verification_in_progress':
      return 'verification_in_progress';
    case 'execution_failed':
    case 'failed':
      return 'execution_failed';
    case 'needs_additional_decision':
      return 'needs_additional_decision';
    case 'waiting_completion_confirmation':
      return 'waiting_completion_confirmation';
    case 'rejected':
      return 'rejected';
    case 'reopened':
      return 'reopened';
    case 'completed':
      return 'completed';
    default:
      return 'open';
  }
}

function mapAuthor(value: unknown): IncidentCaseMessageAuthor {
  const normalized = cleanText(value).toLowerCase();
  if (normalized === 'investigator') return 'investigator';
  if (normalized === 'operator') return 'operator';
  return 'system';
}

function mapCaseSummary(incidentCase: any): string {
  return cleanText(incidentCase?.summary)
    || cleanText(incidentCase?.user_impact_summary)
    || 'ללא סיכום';
}

function mapMessageFromEvent(event: any): IncidentCaseMessage {
  return {
    id: cleanText(event?.incident_case_event_id) || `evt_${randomUUID()}`,
    createdAt: cleanText(event?.created_at) || nowIso(),
    author: mapAuthor(event?.actor_type),
    kind: cleanText(event?.kind) || 'event',
    text: cleanText(event?.text) || 'עודכן אירוע בתיק.',
    payload: event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? JSON.parse(JSON.stringify(event.payload))
      : null,
  };
}

function sortCases(records: IncidentCaseRecord[]): IncidentCaseRecord[] {
  return [...records].sort((left, right) => (
    String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
  ));
}

function buildCaseRecordFromPackage(pkg: any): IncidentCaseRecord {
  const incidentCase = pkg?.incident_case || {};
  const events = Array.isArray(pkg?.events) ? pkg.events : [];
  const messages = events.map(mapMessageFromEvent);
  return {
    caseId: cleanText(incidentCase?.incident_case_id) || '',
    createdAt: cleanText(incidentCase?.created_at) || nowIso(),
    updatedAt: cleanText(incidentCase?.updated_at) || nowIso(),
    status: mapStatus(incidentCase?.status),
    title: cleanText(incidentCase?.title) || 'תיק הכרעה',
    summary: mapCaseSummary(incidentCase),
    failureTicketId: cleanText(incidentCase?.failure_ticket_id),
    threadId: cleanText(incidentCase?.thread_id),
    messageId: cleanText(incidentCase?.message_id),
    runId: cleanText(incidentCase?.run_id),
    investigatorSessionId: cleanText(incidentCase?.investigator_session_id),
    investigatorProfileId: cleanText(incidentCase?.investigator_profile_id),
    lastWakeAt: cleanText(incidentCase?.last_wake_at),
    lastWakeReason: cleanText(incidentCase?.last_wake_reason),
    lastWakeQueueItemId: cleanText(incidentCase?.last_wake_queue_item_id),
    operatorDecision: cleanText(incidentCase?.last_decision_kind),
    resolutionSummary: cleanText(incidentCase?.completion_reason),
    completedAt: cleanText(incidentCase?.completed_at),
    metadata: {
      ...(incidentCase?.metadata && typeof incidentCase.metadata === 'object' ? incidentCase.metadata : {}),
      reports: Array.isArray(pkg?.reports) ? pkg.reports : [],
      decisions: Array.isArray(pkg?.decisions) ? pkg.decisions : [],
      executions: Array.isArray(pkg?.executions) ? pkg.executions : [],
      package: pkg,
    },
    messages,
  };
}

function buildCaseRecordFromListEntry(entry: any): IncidentCaseRecord {
  return {
    caseId: cleanText(entry?.incident_case_id) || '',
    createdAt: cleanText(entry?.created_at) || nowIso(),
    updatedAt: cleanText(entry?.updated_at) || nowIso(),
    status: mapStatus(entry?.status),
    title: cleanText(entry?.title) || 'תיק הכרעה',
    summary: mapCaseSummary(entry),
    failureTicketId: cleanText(entry?.failure_ticket_id),
    threadId: cleanText(entry?.thread_id),
    messageId: cleanText(entry?.message_id),
    runId: cleanText(entry?.run_id),
    investigatorSessionId: cleanText(entry?.investigator_session_id),
    investigatorProfileId: cleanText(entry?.investigator_profile_id),
    lastWakeAt: cleanText(entry?.last_wake_at),
    lastWakeReason: cleanText(entry?.last_wake_reason),
    lastWakeQueueItemId: cleanText(entry?.last_wake_queue_item_id),
    operatorDecision: cleanText(entry?.last_decision_kind),
    resolutionSummary: cleanText(entry?.completion_reason),
    completedAt: cleanText(entry?.completed_at),
    metadata: entry?.metadata && typeof entry.metadata === 'object' ? JSON.parse(JSON.stringify(entry.metadata)) : {},
    messages: [],
  };
}

async function writeIncidentContextFile(caseRecord: IncidentCaseRecord, taskType: string) {
  const packagePayload = caseRecord.metadata?.package || {};
  const contextDir = path.join(INCIDENT_CONTEXT_ROOT, caseRecord.caseId);
  await fs.mkdir(contextDir, { recursive: true });
  const filePath = path.join(contextDir, `${Date.now()}-${taskType}.json`);
  await fs.writeFile(filePath, JSON.stringify(packagePayload, null, 2), 'utf-8');
  return filePath;
}

async function recordIncidentCaseEvent(caseId: string, payload: Record<string, unknown>) {
  try {
    await requestJson(`/v1/incident-cases/${encodeURIComponent(cleanText(caseId))}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch {
    // The wake result itself must not disappear because the bookkeeping update failed.
  }
}

function buildWakePrompt(caseRecord: IncidentCaseRecord, taskType: string, contextFilePath: string) {
  const taskLabels: Record<string, string> = {
    initial_investigation: 'חקירה ראשונה',
    operator_response: 'מענה לתגובת מפעיל',
    operator_decision: 'בחינת הכרעת מפעיל',
    execute_decision: 'ביצוע הכרעה',
    reopened_case: 'טיפול בפתיחה מחדש',
  };
  const taskLabel = taskLabels[taskType] || taskType;
  return [
    `טפל עכשיו בתיק ההכרעה ${caseRecord.caseId}.`,
    `סוג המשימה: ${taskLabel}.`,
    caseRecord.failureTicketId ? `מזהה טיקט כשל: ${caseRecord.failureTicketId}.` : '',
    caseRecord.threadId ? `מזהה שרשור: ${caseRecord.threadId}.` : '',
    caseRecord.messageId ? `מזהה הודעה: ${caseRecord.messageId}.` : '',
    caseRecord.runId ? `מזהה ריצה: ${caseRecord.runId}.` : '',
    '',
    `קובץ ההקשר הקנוני לתיק נמצא כאן: ${contextFilePath}`,
    '',
    'כללי עבודה מחייבים:',
    taskType === 'execute_decision'
      ? '1. קרא את קובץ ההקשר המלא ואת ההכרעה המאושרת שבתוכו.'
      : '1. קרא את קובץ ההקשר המלא לפני כל פעולה.',
    taskType === 'execute_decision'
      ? '2. מותר לבצע רק את מה שאושר במפורש. אם משהו השתנה מהותית, עצור והחזר להכרעה.'
      : '2. אסור לבצע שינוי כלשהו לפני אישור מפורש לביצוע.',
    taskType === 'execute_decision'
      ? '3. שמור דוח ביצוע מלא עם כל שינוי, בדיקה, פריסה ואימות.'
      : '3. חקור לעומק, הפרד בין עובדה להשערה, והגש דוח ברור עם המלצה אחת.',
    '4. עדכן את תיק ההכרעה באמצעות הסקריפט:',
    'node /root/projects/code-ai/scripts/incident-case-update.mjs ...',
    '',
    'אם זו חקירה או מענה למפעיל:',
    `node /root/projects/code-ai/scripts/incident-case-update.mjs report --case ${caseRecord.caseId} --context ${contextFilePath} --summary-file <path-to-your-json>`,
    '',
    'אם זו הודעה חופשית למפעיל:',
    `node /root/projects/code-ai/scripts/incident-case-update.mjs message --case ${caseRecord.caseId} --text-file <path-to-text> --kind investigator_reply`,
    '',
    'אם זו משימת ביצוע:',
    `node /root/projects/code-ai/scripts/incident-case-update.mjs execution --case ${caseRecord.caseId} --context ${contextFilePath} --summary-file <path-to-your-json>`,
  ].filter(Boolean).join('\n');
}

export function createIncidentDecisionCenterService() {
  return {
    async listCases(filter: { status?: string | null } = {}) {
      const query = new URLSearchParams();
      if (cleanText(filter.status)) {
        query.set('status', cleanText(filter.status) as string);
      }
      const suffix = query.toString() ? `?${query.toString()}` : '';
      const response = await requestJson(`/v1/incident-cases${suffix}`, {
        method: 'GET',
      });
      const cases = Array.isArray(response?.incident_cases)
        ? response.incident_cases.map(buildCaseRecordFromListEntry)
        : [];
      return sortCases(cases);
    },

    async getCase(caseId: string) {
      const response = await requestJson(`/v1/incident-cases/${encodeURIComponent(cleanText(caseId))}/package`, {
        method: 'GET',
      });
      const pkg = response?.package || null;
      return pkg ? buildCaseRecordFromPackage(pkg) : null;
    },

    async createCase(payload: {
      caseId?: string;
      title: string;
      summary: string;
      failureTicketId?: string | null;
      threadId?: string | null;
      messageId?: string | null;
      runId?: string | null;
      investigatorSessionId?: string | null;
      investigatorProfileId?: string | null;
      metadata?: Record<string, unknown>;
      investigatorPrompt?: string | null;
      autoWake?: boolean;
    }) {
      const response = await requestJson('/v1/incident-cases', {
        method: 'POST',
        body: JSON.stringify({
          incident_case_id: payload.caseId || null,
          title: payload.title,
          summary: payload.summary,
          failure_ticket_id: payload.failureTicketId || null,
          thread_id: payload.threadId || null,
          message_id: payload.messageId || null,
          run_id: payload.runId || null,
          investigator_session_id: payload.investigatorSessionId || DEFAULT_INCIDENT_SESSION_ID || null,
          investigator_profile_id: payload.investigatorProfileId || DEFAULT_INCIDENT_PROFILE_ID || null,
          metadata: payload.metadata || {},
          event_id: `manual_case:${randomUUID()}`,
        }),
      });
      const incidentCase = buildCaseRecordFromListEntry(response?.incident_case || {});
      return {
        caseRecord: incidentCase,
        wakeResult: null,
      };
    },

    async appendMessage(caseId: string, payload: {
      author: IncidentCaseMessageAuthor;
      kind: string;
      text: string;
      messagePayload?: Record<string, unknown> | null;
      status?: IncidentCaseStatus | null;
      operatorDecision?: string | null;
      resolutionSummary?: string | null;
      wakeInvestigator?: boolean;
      wakeReason?: string | null;
      wakePrompt?: string | null;
    }) {
      const normalizedCaseId = cleanText(caseId);
      const kind = cleanText(payload.kind) || 'note';
      const author = mapAuthor(payload.author);
      const text = cleanText(payload.text) || 'נשמר עדכון בתיק.';
      let response;

      if (kind === 'operator_completion' || payload.status === 'completed') {
        response = await requestJson(`/v1/incident-cases/${encodeURIComponent(normalizedCaseId)}/complete`, {
          method: 'POST',
          body: JSON.stringify({
            actor_type: author,
            text,
            summary: payload.resolutionSummary || text,
            completion_reason: payload.resolutionSummary || text,
            completion_type: payload.operatorDecision || 'completed',
            idempotency_key: `complete:${randomUUID()}`,
          }),
        });
      } else if (kind === 'operator_decision' || cleanText(payload.operatorDecision) || payload.status === 'approved_for_execution') {
        response = await requestJson(`/v1/incident-cases/${encodeURIComponent(normalizedCaseId)}/decisions`, {
          method: 'POST',
          body: JSON.stringify({
            actor_type: author,
            decision_kind: cleanText(payload.operatorDecision) || payload.status || 'operator_decision',
            summary: text,
            contract: payload.messagePayload || {},
            status: payload.status || null,
            execution_scope: Array.isArray((payload.messagePayload as any)?.execution_scope)
              ? (payload.messagePayload as any).execution_scope
              : [],
            test_plan: Array.isArray((payload.messagePayload as any)?.test_plan)
              ? (payload.messagePayload as any).test_plan
              : [],
            idempotency_key: `decision:${randomUUID()}`,
          }),
        });
      } else if (author === 'investigator' && kind.includes('execution')) {
        response = await requestJson(`/v1/incident-cases/${encodeURIComponent(normalizedCaseId)}/executions`, {
          method: 'POST',
          body: JSON.stringify({
            actor_type: author,
            summary: text,
            status: payload.status || 'execution_in_progress',
            execution_report: payload.messagePayload || {},
            idempotency_key: `execution:${randomUUID()}`,
          }),
        });
      } else if (author === 'investigator' && (kind.includes('report') || kind.includes('recommendation'))) {
        response = await requestJson(`/v1/incident-cases/${encodeURIComponent(normalizedCaseId)}/reports`, {
          method: 'POST',
          body: JSON.stringify({
            actor_type: author,
            summary: text,
            report_sections: payload.messagePayload || {},
            recommendation: cleanText((payload.messagePayload as any)?.recommendation) || text,
            root_cause: cleanText((payload.messagePayload as any)?.root_cause),
            operator_question: cleanText((payload.messagePayload as any)?.operator_question),
            confidence_level: cleanText((payload.messagePayload as any)?.confidence_level) || 'high',
            facts: Array.isArray((payload.messagePayload as any)?.facts) ? (payload.messagePayload as any).facts : [],
            timeline: Array.isArray((payload.messagePayload as any)?.timeline) ? (payload.messagePayload as any).timeline : [],
            alternatives: Array.isArray((payload.messagePayload as any)?.alternatives) ? (payload.messagePayload as any).alternatives : [],
            test_plan: Array.isArray((payload.messagePayload as any)?.test_plan) ? (payload.messagePayload as any).test_plan : [],
            idempotency_key: `report:${randomUUID()}`,
          }),
        });
      } else {
        response = await requestJson(`/v1/incident-cases/${encodeURIComponent(normalizedCaseId)}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            actor_type: author,
            kind,
            text,
            payload: payload.messagePayload || {},
            status_after: payload.status || null,
            idempotency_key: `message:${randomUUID()}`,
          }),
        });
      }

      const caseRecord = await this.getCase(normalizedCaseId);
      return {
        caseRecord,
        message: caseRecord?.messages?.[caseRecord.messages.length - 1] || null,
        wakeResult: null,
        raw: response,
      };
    },

    async recordDecision(caseId: string, payload: {
      author?: IncidentCaseMessageAuthor;
      decisionKind: string;
      summary: string;
      status?: IncidentCaseStatus | null;
      contract?: Record<string, unknown> | null;
      executionScope?: unknown[];
      testPlan?: unknown[];
    }) {
      const normalizedCaseId = cleanText(caseId);
      const summary = cleanText(payload.summary) || 'נשמרה הכרעת מפעיל.';
      const response = await requestJson(`/v1/incident-cases/${encodeURIComponent(normalizedCaseId)}/decisions`, {
        method: 'POST',
        body: JSON.stringify({
          actor_type: mapAuthor(payload.author || 'operator'),
          decision_kind: cleanText(payload.decisionKind) || 'operator_decision',
          summary,
          status: payload.status || null,
          contract: payload.contract || {},
          execution_scope: Array.isArray(payload.executionScope) ? payload.executionScope : [],
          test_plan: Array.isArray(payload.testPlan) ? payload.testPlan : [],
          idempotency_key: `decision:${randomUUID()}`,
        }),
      });
      return {
        caseRecord: await this.getCase(normalizedCaseId),
        raw: response,
      };
    },

    async completeCase(caseId: string, payload: {
      author?: IncidentCaseMessageAuthor;
      summary: string;
      completionType?: string | null;
      completionReason?: string | null;
      details?: Record<string, unknown> | null;
    }) {
      const normalizedCaseId = cleanText(caseId);
      const summary = cleanText(payload.summary) || 'התיק הושלם.';
      const response = await requestJson(`/v1/incident-cases/${encodeURIComponent(normalizedCaseId)}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          actor_type: mapAuthor(payload.author || 'operator'),
          summary,
          completion_type: cleanText(payload.completionType) || 'completed',
          completion_reason: cleanText(payload.completionReason) || summary,
          payload: payload.details || {},
          idempotency_key: `complete:${randomUUID()}`,
        }),
      });
      return {
        caseRecord: await this.getCase(normalizedCaseId),
        raw: response,
      };
    },

    async reopenCase(caseId: string, payload: {
      author?: IncidentCaseMessageAuthor;
      summary: string;
      reason?: string | null;
      details?: Record<string, unknown> | null;
    }) {
      const normalizedCaseId = cleanText(caseId);
      const summary = cleanText(payload.summary) || 'התיק נפתח מחדש.';
      const response = await requestJson(`/v1/incident-cases/${encodeURIComponent(normalizedCaseId)}/reopen`, {
        method: 'POST',
        body: JSON.stringify({
          actor_type: mapAuthor(payload.author || 'operator'),
          summary,
          reason: cleanText(payload.reason) || summary,
          payload: payload.details || {},
          idempotency_key: `reopen:${randomUUID()}`,
        }),
      });
      return {
        caseRecord: await this.getCase(normalizedCaseId),
        raw: response,
      };
    },

    async wakeSessionTask(payload: {
      taskType: string;
      caseId: string;
    }) {
      const caseRecord = await this.getCase(payload.caseId);
      if (!caseRecord) {
        throw new Error('incident_case_not_found');
      }
      const profileId = caseRecord.investigatorProfileId || DEFAULT_INCIDENT_PROFILE_ID;
      const sessionId = caseRecord.investigatorSessionId || DEFAULT_INCIDENT_SESSION_ID;
      if (!profileId || !sessionId) {
        throw new Error('incident_investigator_target_missing');
      }
      const contextFilePath = await writeIncidentContextFile(caseRecord, payload.taskType);
      try {
        const item = await enqueueCodexQueueItem({
          profileId,
          queueKey: sessionId,
          sessionId,
          prompt: buildWakePrompt(caseRecord, payload.taskType, contextFilePath),
          promptPreview: `הכרעה · ${caseRecord.caseId} · ${payload.taskType}`,
        });
        const wakeRecordedAt = nowIso();
        await recordIncidentCaseEvent(caseRecord.caseId, {
          actor_type: 'system',
          kind: 'wake_requested',
          text: 'הסשן החוקר הוקפץ למשימה חדשה.',
          payload: {
            task_type: payload.taskType,
            queue_item_id: item.id,
            queue_status: item.status,
            session_id: item.sessionId || sessionId,
            profile_id: item.profileId,
            context_file_path: contextFilePath,
          },
          case_patch: {
            last_wake_at: wakeRecordedAt,
            last_wake_reason: payload.taskType,
            last_wake_queue_item_id: item.id,
            last_error: null,
          },
          signal_type: 'incident_event',
          idempotency_key: `wake:${payload.taskType}:${item.id}`,
        });
        return {
          queue_item_id: item.id,
          queue_status: item.status,
          session_id: item.sessionId || sessionId,
          profile_id: item.profileId,
          context_file_path: contextFilePath,
        };
      } catch (error: any) {
        await recordIncidentCaseEvent(caseRecord.caseId, {
          actor_type: 'system',
          kind: 'wake_failed',
          text: 'הקפצת הסשן החוקר נכשלה.',
          payload: {
            task_type: payload.taskType,
            session_id: sessionId,
            profile_id: profileId,
            context_file_path: contextFilePath,
            error_message: error?.message || String(error),
          },
          case_patch: {
            last_wake_at: nowIso(),
            last_wake_reason: payload.taskType,
            last_wake_queue_item_id: null,
            last_error: {
              stage: 'wake_session_task',
              task_type: payload.taskType,
              message: error?.message || String(error),
            },
          },
          signal_type: 'incident_event',
          idempotency_key: `wake_failed:${payload.taskType}:${caseRecord.caseId}:${Date.now()}`,
        });
        throw error;
      }
    },
  };
}

function escapeHtml(value: unknown): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildIncidentDecisionCenterHtml() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>מרכז הכרעה</title>
  <style>
    :root {
      --bg: #f3efe7;
      --card: rgba(255,255,255,.92);
      --ink: #1f2328;
      --muted: #69707a;
      --line: #d8d2c7;
      --accent: #0f766e;
      --accent-2: #d97706;
      --shadow: 0 18px 50px rgba(31,35,40,.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Noto Sans Hebrew", "Heebo", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top right, rgba(15,118,110,.12), transparent 26%),
        radial-gradient(circle at bottom left, rgba(217,119,6,.12), transparent 28%),
        linear-gradient(180deg, #f7f2e8 0%, #efe8dc 100%);
      min-height: 100vh;
    }
    .shell {
      max-width: 1320px;
      margin: 0 auto;
      padding: 18px;
      display: grid;
      gap: 16px;
      grid-template-columns: 360px minmax(0, 1fr);
    }
    .panel {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 22px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
    }
    .sidebar { padding: 16px; }
    .content { padding: 18px; min-height: calc(100vh - 36px); }
    .title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 1.35rem; }
    .sub { color: var(--muted); font-size: .94rem; }
    .filters { display: flex; gap: 8px; margin: 14px 0 10px; flex-wrap: wrap; }
    button, select, textarea, input {
      font: inherit;
    }
    .pill, .action {
      border: 1px solid var(--line);
      background: white;
      border-radius: 999px;
      padding: 8px 12px;
      cursor: pointer;
    }
    .pill.active {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
    }
    .case-list {
      display: grid;
      gap: 10px;
      max-height: calc(100vh - 180px);
      overflow: auto;
      padding-right: 2px;
    }
    .case-card {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: white;
      padding: 12px;
      cursor: pointer;
    }
    .case-card.active {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(15,118,110,.12);
    }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }
    .badge {
      border-radius: 999px;
      padding: 4px 10px;
      font-size: .78rem;
      background: rgba(15,118,110,.1);
      color: var(--accent);
      white-space: nowrap;
    }
    .summary {
      margin-top: 6px;
      color: var(--muted);
      font-size: .92rem;
      line-height: 1.45;
    }
    .detail-head { display: grid; gap: 8px; margin-bottom: 16px; }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: 8px;
    }
    .meta {
      background: rgba(247,242,232,.85);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 10px 12px;
      min-height: 72px;
    }
    .meta strong {
      display: block;
      margin-bottom: 4px;
      font-size: .86rem;
    }
    .snapshot-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin: 14px 0 18px;
    }
    .snapshot-card {
      border: 1px solid var(--line);
      border-radius: 20px;
      background: rgba(255,255,255,.96);
      padding: 14px;
      display: grid;
      gap: 10px;
    }
    .snapshot-card h3 {
      font-size: 1rem;
    }
    .stack {
      display: grid;
      gap: 8px;
    }
    .field {
      display: grid;
      gap: 4px;
      padding: 8px 10px;
      background: #faf7f2;
      border: 1px solid var(--line);
      border-radius: 14px;
    }
    .field strong {
      font-size: .83rem;
      color: var(--muted);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 6px 10px;
      background: rgba(15,118,110,.08);
      border: 1px solid rgba(15,118,110,.15);
      font-size: .82rem;
    }
    .list-box {
      margin: 0;
      padding: 0 18px 0 0;
      display: grid;
      gap: 6px;
      color: var(--ink);
      line-height: 1.55;
    }
    .composer-grid {
      display: grid;
      gap: 10px;
    }
    .input-row {
      display: grid;
      gap: 8px;
    }
    .input-row label {
      font-size: .9rem;
      color: var(--muted);
    }
    select, input[type="text"] {
      border-radius: 14px;
      border: 1px solid var(--line);
      background: white;
      padding: 11px 12px;
    }
    .hint {
      color: var(--muted);
      font-size: .88rem;
      line-height: 1.5;
      background: rgba(247,242,232,.85);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 10px 12px;
    }
    .scope-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .scope-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: white;
    }
    .timeline {
      display: grid;
      gap: 12px;
      margin: 18px 0;
    }
    .entry {
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 12px 14px;
      background: white;
    }
    .entry header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
      color: var(--muted);
      font-size: .82rem;
    }
    .entry.investigator { border-right: 4px solid var(--accent); }
    .entry.operator { border-right: 4px solid var(--accent-2); }
    .entry.system { border-right: 4px solid #64748b; }
    .entry pre {
      margin: 8px 0 0;
      white-space: pre-wrap;
      background: #faf7f2;
      border-radius: 12px;
      padding: 10px;
      overflow: auto;
    }
    details {
      border-top: 1px dashed var(--line);
      padding-top: 8px;
    }
    summary {
      cursor: pointer;
      color: var(--accent);
      font-size: .86rem;
    }
    .composer {
      border-top: 1px solid var(--line);
      padding-top: 14px;
      display: grid;
      gap: 10px;
    }
    textarea {
      min-height: 120px;
      resize: vertical;
      border-radius: 18px;
      border: 1px solid var(--line);
      padding: 12px;
      background: white;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .action.primary {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
    }
    .action.warn {
      background: var(--accent-2);
      color: white;
      border-color: var(--accent-2);
    }
    .empty {
      padding: 40px 18px;
      text-align: center;
      color: var(--muted);
    }
    @media (max-width: 980px) {
      .shell { grid-template-columns: 1fr; }
      .content { min-height: auto; }
      .meta-grid { grid-template-columns: 1fr; }
      .snapshot-grid { grid-template-columns: 1fr; }
      .scope-grid { grid-template-columns: 1fr; }
      .case-list { max-height: 42vh; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="panel sidebar">
      <div class="title">
        <div>
          <h1>🧭 מרכז הכרעה</h1>
          <p class="sub">מקרי חקירה, הכרעה והשלמה</p>
        </div>
      </div>
      <div class="filters">
        <button class="pill active" data-filter="">הכל</button>
        <button class="pill" data-filter="waiting_operator">ממתינים למפעיל</button>
        <button class="pill" data-filter="waiting_investigator">ממתינים לחוקר</button>
        <button class="pill" data-filter="approved_for_execution">אושר לביצוע</button>
        <button class="pill" data-filter="execution_in_progress">בביצוע</button>
        <button class="pill" data-filter="completed">הושלמו</button>
      </div>
      <div id="case-list" class="case-list"></div>
    </aside>
    <main class="panel content">
      <div id="empty" class="empty">בחרו מקרה מן הצד כדי לראות את כל ההיסטוריה וההכרעות.</div>
      <div id="detail" hidden></div>
    </main>
  </div>
  <script>
    const DRAFT_STORAGE_KEY = 'incident-center-drafts-v2';
    const statusLabels = {
      open: 'פתוח',
      waiting_investigator: 'ממתין לחוקר',
      waiting_operator: 'ממתין למפעיל',
      needs_more_evidence: 'חסרות ראיות',
      approved_for_execution: 'אושר לביצוע',
      execution_in_progress: 'בביצוע',
      verification_in_progress: 'באימות',
      execution_failed: 'הביצוע נכשל',
      needs_additional_decision: 'נדרשת הכרעה נוספת',
      waiting_completion_confirmation: 'ממתין לאישור השלמה',
      rejected: 'נדחה',
      reopened: 'נפתח מחדש',
      completed: 'הושלם',
    };
    const authorLabels = {
      system: 'מערכת',
      investigator: 'חוקר',
      operator: 'מפעיל',
    };
    const kindLabels = {
      case_opened: 'נפתח תיק',
      wake_requested: 'נשלחה משימת חקירה',
      wake_failed: 'הקפצת סשן נכשלה',
      operator_reply: 'תגובת מפעיל',
      operator_research_request: 'בקשת חקירה נוספת',
      operator_note: 'הערת מפעיל',
      investigator_report_submitted: 'דוח חקירה',
      investigator_reply: 'מענה חוקר',
      operator_decision_recorded: 'הכרעת מפעיל',
      execution_update_recorded: 'עדכון ביצוע',
      case_completed: 'סיום תיק',
      case_reopened: 'פתיחה מחדש',
    };
    const actionHints = {
      send_to_investigator: 'שלחו שאלה, תיקון או תגובה חופשית לחוקר. הסשן יתעורר שוב באותו תיק.',
      request_more_research: 'בקשו מהחוקר לאסוף עוד ראיות, לבדוק חלופה או להעמיק במשהו מסוים.',
      approve_execution: 'אשרו את ההמלצה לביצוע בפועל. חובה לבחור לפחות תחום ביצוע אחד.',
      reject_recommendation: 'דחו את ההמלצה הקיימת. חובה לכתוב למה ומה לא מקובל בה.',
      mark_expected_behavior: 'סגרו את התיק כמצב צפוי שאינו דורש תיקון.',
      mark_duplicate_case: 'סגרו את התיק ככפול של מקרה אחר. אפשר לציין מזהה תיק היעד.',
      complete_without_fix: 'סגרו את התיק ללא תיקון קוד, עם הסבר מפורש למה זה מספיק.',
      complete_resolved: 'סמנו שהטיפול הושלם לאחר שהביצוע והאימות הסתיימו.',
      reopen_case: 'פתחו מחדש תיק שהושלם או הוקפא, עם הסבר מה השתנה.',
    };
    const actionLabels = {
      send_to_investigator: 'שלח לחוקר',
      request_more_research: 'בקש חקירה נוספת',
      approve_execution: 'אשר ובצע',
      reject_recommendation: 'דחה המלצה',
      mark_expected_behavior: 'סמן מצב צפוי',
      mark_duplicate_case: 'סמן כתיק כפול',
      complete_without_fix: 'השלם ללא תיקון',
      complete_resolved: 'סמן כהושלם',
      reopen_case: 'פתח מחדש',
    };
    const executionScopeOptions = [
      { value: 'code', label: 'קוד' },
      { value: 'configuration', label: 'קונפיגורציה' },
      { value: 'data', label: 'תיקון נתונים' },
      { value: 'deployment', label: 'פריסה' },
      { value: 'replay', label: 'הרצה חוזרת' },
    ];
    const state = { filter: '', cases: [], selectedId: null, drafts: loadDrafts() };
    const caseListEl = document.getElementById('case-list');
    const detailEl = document.getElementById('detail');
    const emptyEl = document.getElementById('empty');
    const filterButtons = [...document.querySelectorAll('[data-filter]')];

    function fmt(value) {
      if (!value) return '—';
      try { return new Date(value).toLocaleString('he-IL'); } catch { return value; }
    }

    function esc(value) {
      return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    }

    function statusLabel(value) {
      return statusLabels[value] || value || 'ללא מצב';
    }

    function authorLabel(value) {
      return authorLabels[value] || value || 'לא ידוע';
    }

    function kindLabel(value) {
      return kindLabels[value] || value || 'עדכון';
    }

    function normalizeArray(value) {
      return Array.isArray(value) ? value : [];
    }

    function latest(value) {
      const items = normalizeArray(value);
      return items.length ? items[items.length - 1] : null;
    }

    function emptyDraft() {
      return {
        note: '',
        action: 'send_to_investigator',
        duplicateOf: '',
        executionScope: [],
      };
    }

    function loadDrafts() {
      try {
        const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    function saveDrafts() {
      try {
        window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(state.drafts || {}));
      } catch {}
    }

    function readDraft(caseId) {
      const existing = state.drafts[caseId];
      if (!existing || typeof existing !== 'object') {
        return emptyDraft();
      }
      return {
        note: String(existing.note || ''),
        action: String(existing.action || 'send_to_investigator'),
        duplicateOf: String(existing.duplicateOf || ''),
        executionScope: normalizeArray(existing.executionScope).map((entry) => String(entry || '')).filter(Boolean),
      };
    }

    function rememberDraft(caseId, patch) {
      if (!caseId) return;
      const nextDraft = {
        ...emptyDraft(),
        ...readDraft(caseId),
        ...(patch || {}),
      };
      const keep =
        nextDraft.note.trim() ||
        nextDraft.action !== 'send_to_investigator' ||
        nextDraft.duplicateOf.trim() ||
        normalizeArray(nextDraft.executionScope).length > 0;
      if (!keep) {
        delete state.drafts[caseId];
      } else {
        state.drafts[caseId] = nextDraft;
      }
      saveDrafts();
    }

    function readCurrentDraftState() {
      const noteInput = document.getElementById('operator-note');
      const actionSelect = document.getElementById('operator-action');
      const duplicateInput = document.getElementById('duplicate-of');
      const executionScope = [...document.querySelectorAll('[data-scope-item]:checked')].map((entry) => entry.value);
      return {
        note: noteInput ? noteInput.value : '',
        action: actionSelect ? actionSelect.value : 'send_to_investigator',
        duplicateOf: duplicateInput ? duplicateInput.value : '',
        executionScope,
      };
    }

    async function loadCases() {
      if (state.selectedId) {
        rememberDraft(state.selectedId, readCurrentDraftState());
      }
      const query = state.filter ? '?status=' + encodeURIComponent(state.filter) : '';
      const res = await fetch('./incident-cases' + query, { credentials: 'same-origin' });
      const data = await res.json();
      state.cases = Array.isArray(data.cases) ? data.cases : [];
      if (!state.selectedId && state.cases[0]) state.selectedId = state.cases[0].caseId;
      if (state.selectedId && !state.cases.some((entry) => entry.caseId === state.selectedId)) {
        state.selectedId = state.cases[0]?.caseId || null;
      }
      renderList();
      if (state.selectedId) await loadCase(state.selectedId); else renderEmpty();
    }

    async function loadCase(caseId) {
      const res = await fetch('./incident-cases/' + encodeURIComponent(caseId), { credentials: 'same-origin' });
      const data = await res.json();
      renderDetail(data.caseRecord || null);
    }

    function renderEmpty() {
      detailEl.hidden = true;
      emptyEl.hidden = false;
    }

    function renderList() {
      caseListEl.innerHTML = state.cases.map((entry) => {
        const active = entry.caseId === state.selectedId ? ' active' : '';
        return '<article class="case-card' + active + '" data-case-id="' + esc(entry.caseId) + '">' +
          '<div class="row"><strong>' + esc(entry.title) + '</strong><span class="badge">' + esc(statusLabel(entry.status)) + '</span></div>' +
          '<div class="summary">' + esc(entry.summary || '') + '</div>' +
          '<div class="summary">עודכן: ' + esc(fmt(entry.updatedAt)) + '</div>' +
          '</article>';
      }).join('');
      [...caseListEl.querySelectorAll('[data-case-id]')].forEach((card) => {
        card.addEventListener('click', async () => {
          state.selectedId = card.getAttribute('data-case-id');
          renderList();
          await loadCase(state.selectedId);
        });
      });
    }

    function meta(label, value) {
      return '<div class="meta"><strong>' + esc(label) + '</strong><span>' + esc(value || '—') + '</span></div>';
    }

    function field(label, value) {
      if (!value) return '';
      return '<div class="field"><strong>' + esc(label) + '</strong><span>' + esc(value) + '</span></div>';
    }

    function renderListBox(items) {
      const rows = normalizeArray(items).map((entry) => '<li>' + esc(typeof entry === 'string' ? entry : JSON.stringify(entry)) + '</li>');
      if (!rows.length) return '';
      return '<ul class="list-box">' + rows.join('') + '</ul>';
    }

    function renderChips(items) {
      const rows = normalizeArray(items).map((entry) => '<span class="chip">' + esc(typeof entry === 'string' ? entry : JSON.stringify(entry)) + '</span>');
      if (!rows.length) return '';
      return '<div class="chips">' + rows.join('') + '</div>';
    }

    function renderJsonDetails(title, value) {
      if (!value) return '';
      return '<details><summary>' + esc(title) + '</summary><pre>' + esc(JSON.stringify(value, null, 2)) + '</pre></details>';
    }

    function renderReportCard(report) {
      if (!report) {
        return '<article class="snapshot-card"><h3>🕵️ הדוח האחרון</h3><p class="sub">עדיין לא נשמר דוח חקירה.</p></article>';
      }
      return '<article class="snapshot-card">' +
        '<h3>🕵️ הדוח האחרון</h3>' +
        '<div class="stack">' +
        field('סיכום', report.summary || report.report_summary || '') +
        field('המלצה', report.recommendation || '') +
        field('סיבת שורש', report.root_cause || '') +
        field('שאלת הכרעה', report.operator_question || '') +
        field('רמת ודאות', report.confidence_level || '') +
        (normalizeArray(report.facts).length ? '<div class="field"><strong>עובדות</strong>' + renderListBox(report.facts) + '</div>' : '') +
        (normalizeArray(report.alternatives).length ? '<div class="field"><strong>חלופות</strong>' + renderListBox(report.alternatives) + '</div>' : '') +
        (normalizeArray(report.test_plan).length ? '<div class="field"><strong>תוכנית בדיקה</strong>' + renderListBox(report.test_plan) + '</div>' : '') +
        renderJsonDetails('פתחו את דוח החקירה המלא', report) +
        '</div>' +
        '</article>';
    }

    function renderDecisionCard(decision) {
      if (!decision) {
        return '<article class="snapshot-card"><h3>✅ ההכרעה האחרונה</h3><p class="sub">עדיין לא נשמרה הכרעת מפעיל.</p></article>';
      }
      return '<article class="snapshot-card">' +
        '<h3>✅ ההכרעה האחרונה</h3>' +
        '<div class="stack">' +
        field('סוג הכרעה', decision.decision_kind || '') +
        field('סיכום', decision.summary || decision.decision_summary || '') +
        field('אושר לפי דוח', decision.approved_report_id || '') +
        (normalizeArray(decision.execution_scope).length ? '<div class="field"><strong>היקף ביצוע</strong>' + renderChips(decision.execution_scope) + '</div>' : '') +
        (normalizeArray(decision.test_plan).length ? '<div class="field"><strong>בדיקות שנדרשו</strong>' + renderListBox(decision.test_plan) + '</div>' : '') +
        (normalizeArray(decision.risks).length ? '<div class="field"><strong>סיכונים</strong>' + renderListBox(decision.risks) + '</div>' : '') +
        renderJsonDetails('פתחו את ההכרעה המלאה', decision) +
        '</div>' +
        '</article>';
    }

    function renderExecutionCard(execution) {
      if (!execution) {
        return '<article class="snapshot-card"><h3>🛠️ הביצוע האחרון</h3><p class="sub">עדיין לא נשמר דוח ביצוע.</p></article>';
      }
      return '<article class="snapshot-card">' +
        '<h3>🛠️ הביצוע האחרון</h3>' +
        '<div class="stack">' +
        field('מצב ביצוע', statusLabel(execution.status || '')) +
        field('סיכום', execution.summary || execution.execution_summary || '') +
        (normalizeArray(execution.changed_files).length ? '<div class="field"><strong>קבצים ששונו</strong>' + renderListBox(execution.changed_files) + '</div>' : '') +
        (normalizeArray(execution.deployments).length ? '<div class="field"><strong>פריסות</strong>' + renderListBox(execution.deployments) + '</div>' : '') +
        (normalizeArray(execution.test_results).length ? '<div class="field"><strong>תוצאות בדיקה</strong>' + renderListBox(execution.test_results) + '</div>' : '') +
        (normalizeArray(execution.verification_results).length ? '<div class="field"><strong>אימותים</strong>' + renderListBox(execution.verification_results) + '</div>' : '') +
        renderJsonDetails('פתחו את דוח הביצוע המלא', execution) +
        '</div>' +
        '</article>';
    }

    function renderActionOptions(selectedAction) {
      return Object.entries(actionLabels).map(([value, label]) => (
        '<option value="' + esc(value) + '"' + (value === selectedAction ? ' selected' : '') + '>' + esc(label) + '</option>'
      )).join('');
    }

    function renderExecutionScope(selectedScope) {
      return executionScopeOptions.map((entry) => (
        '<label class="scope-item"><input type="checkbox" data-scope-item value="' + esc(entry.value) + '"' +
          (normalizeArray(selectedScope).includes(entry.value) ? ' checked' : '') +
        ' />' +
        '<span>' + esc(entry.label) + '</span></label>'
      )).join('');
    }

    function buildTimelineEntry(entry) {
      const payload = entry.payload ? renderJsonDetails('פתחו נתוני אירוע מלאים', entry.payload) : '';
      return '<article class="entry ' + esc(entry.author) + '">' +
        '<header><span>' + esc(authorLabel(entry.author)) + ' · ' + esc(kindLabel(entry.kind)) + '</span><span>' + esc(fmt(entry.createdAt)) + '</span></header>' +
        '<div>' + esc(entry.text) + '</div>' +
        payload +
      '</article>';
    }

    function applyActionUi(caseId) {
      const actionSelect = document.getElementById('operator-action');
      const actionHint = document.getElementById('action-hint');
      const scopeWrap = document.getElementById('execution-scope-wrap');
      const duplicateWrap = document.getElementById('duplicate-wrap');
      const submitButton = document.getElementById('submit-primary');
      const currentAction = actionSelect ? actionSelect.value : 'send_to_investigator';
      if (actionHint) {
        actionHint.textContent = actionHints[currentAction] || '';
      }
      if (scopeWrap) {
        scopeWrap.hidden = currentAction !== 'approve_execution';
      }
      if (duplicateWrap) {
        duplicateWrap.hidden = currentAction !== 'mark_duplicate_case';
      }
      if (submitButton) {
        submitButton.textContent = actionLabels[currentAction] || 'בצע פעולה';
      }
      rememberDraft(caseId, readCurrentDraftState());
    }

    async function submitAction(caseRecord, action) {
      const draft = readCurrentDraftState();
      const body = {
        action,
        text: draft.note,
        duplicateOf: draft.duplicateOf,
        executionScope: draft.executionScope,
      };
      const response = await fetch('./incident-cases/' + encodeURIComponent(caseRecord.caseId) + '/actions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result?.error || 'ביצוע פעולת ההכרעה נכשל.');
      }
      rememberDraft(caseRecord.caseId, emptyDraft());
      await loadCases();
    }

    function renderDetail(caseRecord) {
      if (!caseRecord) {
        renderEmpty();
        return;
      }
      emptyEl.hidden = true;
      detailEl.hidden = false;
      const messages = normalizeArray(caseRecord.messages);
      const pkg = caseRecord.metadata && typeof caseRecord.metadata === 'object'
        ? (caseRecord.metadata.package || {})
        : {};
      const latestReport = latest(pkg.reports);
      const latestDecision = latest(pkg.decisions);
      const latestExecution = latest(pkg.executions);
      const draft = readDraft(caseRecord.caseId);

      detailEl.innerHTML = [
        '<div class="detail-head">',
        '<div class="row"><div><h2>📌 ' + esc(caseRecord.title) + '</h2><p class="sub">' + esc(caseRecord.summary || '') + '</p></div><span class="badge">' + esc(statusLabel(caseRecord.status)) + '</span></div>',
        '<div class="meta-grid">',
        meta('מזהה מקרה', caseRecord.caseId),
        meta('טיקט כשל', caseRecord.failureTicketId),
        meta('שרשור', caseRecord.threadId),
        meta('הודעה אחרונה', caseRecord.messageId),
        meta('ריצה', caseRecord.runId),
        meta('סשן חוקר', caseRecord.investigatorSessionId),
        meta('פרופיל חוקר', caseRecord.investigatorProfileId),
        meta('התעוררות אחרונה', caseRecord.lastWakeAt ? fmt(caseRecord.lastWakeAt) + ' · ' + (caseRecord.lastWakeReason || '') : '—'),
        '</div>',
        '</div>',
        '<section class="snapshot-grid">',
        renderReportCard(latestReport),
        renderDecisionCard(latestDecision),
        renderExecutionCard(latestExecution),
        '</section>',
        '<section class="timeline">',
        messages.length ? messages.map(buildTimelineEntry).join('') : '<div class="empty">עדיין אין אירועים שמורים בתיק.</div>',
        '</section>',
        '<section class="composer">',
        '<div class="composer-grid">',
        '<div class="input-row"><label for="operator-note">הודעת מפעיל</label><textarea id="operator-note" placeholder="כתבו כאן שאלה לחוקר, הכרעה, דחייה, נימוק להשלמה או בקשת חקירה נוספת.">' + esc(draft.note) + '</textarea></div>',
        '<div class="input-row"><label for="operator-action">פעולת מפעיל</label><select id="operator-action">' + renderActionOptions(draft.action) + '</select></div>',
        '<div id="action-hint" class="hint"></div>',
        '<div id="execution-scope-wrap" class="input-row" hidden><label>היקף הביצוע המאושר</label><div class="scope-grid">' + renderExecutionScope(draft.executionScope) + '</div></div>',
        '<div id="duplicate-wrap" class="input-row" hidden><label for="duplicate-of">מזהה תיק היעד במקרה כפילות</label><input id="duplicate-of" type="text" value="' + esc(draft.duplicateOf) + '" placeholder="למשל icase_123456" /></div>',
        '<div class="actions">',
        '<button class="action" id="save-note-button">שמור הערה</button>',
        '<button class="action primary" id="submit-primary">בצע פעולה</button>',
        '</div>',
        '</div>',
        '</section>',
      ].join('');

      const noteInput = document.getElementById('operator-note');
      const actionSelect = document.getElementById('operator-action');
      const duplicateInput = document.getElementById('duplicate-of');
      const saveButton = document.getElementById('save-note-button');
      const submitButton = document.getElementById('submit-primary');

      noteInput.addEventListener('input', () => rememberDraft(caseRecord.caseId, readCurrentDraftState()));
      actionSelect.addEventListener('change', () => applyActionUi(caseRecord.caseId));
      if (duplicateInput) {
        duplicateInput.addEventListener('input', () => rememberDraft(caseRecord.caseId, readCurrentDraftState()));
      }
      detailEl.querySelectorAll('[data-scope-item]').forEach((checkbox) => {
        checkbox.addEventListener('change', () => rememberDraft(caseRecord.caseId, readCurrentDraftState()));
      });

      saveButton.addEventListener('click', async () => {
        try {
          await submitAction(caseRecord, 'save_note');
        } catch (error) {
          emptyEl.hidden = false;
          emptyEl.textContent = 'שמירת ההערה נכשלה: ' + (error?.message || error);
        }
      });

      submitButton.addEventListener('click', async () => {
        try {
          await submitAction(caseRecord, actionSelect.value);
        } catch (error) {
          emptyEl.hidden = false;
          emptyEl.textContent = 'ביצוע פעולת ההכרעה נכשל: ' + (error?.message || error);
        }
      });

      applyActionUi(caseRecord.caseId);
    }

    filterButtons.forEach((button) => {
      button.addEventListener('click', async () => {
        state.filter = button.getAttribute('data-filter') || '';
        filterButtons.forEach((entry) => entry.classList.toggle('active', entry === button));
        await loadCases();
      });
    });

    setInterval(() => {
      loadCases().catch(() => {});
    }, 20000);

    loadCases().catch((error) => {
      emptyEl.hidden = false;
      emptyEl.textContent = 'טעינת מרכז ההכרעה נכשלה: ' + (error?.message || error);
    });
  </script>
</body>
</html>`;
}
