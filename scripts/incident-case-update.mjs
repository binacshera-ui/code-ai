import fs from 'node:fs/promises';
import { loadEnvFile } from '../../../bina-cshera-2.0/platform/shared-runtime/src/env-file.js';

await loadEnvFile('/root/.bina-cshera-secrets/env/bc2-failure.env');

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || null;
}

function normalizeBearerToken(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
}

async function readFilePayload(filePath) {
  const raw = await fs.readFile(filePath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    return {
      summary: raw.trim(),
      text: raw.trim(),
    };
  }
}

function requireValue(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`missing_${label}`);
  }
  return normalized;
}

async function requestJson(baseUrl, authToken, pathname, payload) {
  const headers = {
    'content-type': 'application/json',
  };
  const normalizedAuth = normalizeBearerToken(authToken);
  if (normalizedAuth) {
    headers.Authorization = normalizedAuth;
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : { message: await response.text() };
  if (!response.ok) {
    throw new Error(String(body?.error || body?.message || response.statusText || 'incident_update_failed'));
  }
  return body;
}

const args = process.argv.slice(2);
const command = requireValue(args[0], 'command');
const caseId = requireValue(readFlag(args, '--case'), 'case');
const summaryFile = readFlag(args, '--summary-file');
const textFile = readFlag(args, '--text-file');
const kind = readFlag(args, '--kind');
const contextFile = readFlag(args, '--context');
const baseUrl = String(
  process.env.CODEX_INCIDENT_FAILURE_URL ||
  process.env.BC2_FAILURE_URL ||
  `http://127.0.0.1:${process.env.BC2_FAILURE_PORT || 8210}`
).replace(/\/+$/g, '');
const authToken = process.env.CODEX_INCIDENT_FAILURE_AUTH_TOKEN || process.env.BC2_FAILURE_AUTH_TOKEN || '';

let payload = {};
if (summaryFile) {
  payload = await readFilePayload(summaryFile);
} else if (textFile) {
  const text = (await fs.readFile(textFile, 'utf-8')).trim();
  payload = { text, summary: text };
}

if (contextFile) {
  payload.context_file = contextFile;
}

let pathname = '';
let body = {};

switch (command) {
  case 'message': {
    const text = requireValue(payload.text || payload.summary, 'text');
    pathname = `/v1/incident-cases/${encodeURIComponent(caseId)}/messages`;
    body = {
      actor_type: 'investigator',
      kind: kind || 'investigator_reply',
      text,
      payload,
      idempotency_key: `message:${Date.now()}`,
    };
    break;
  }
  case 'report': {
    const summary = requireValue(payload.summary || payload.recommendation || payload.text, 'summary');
    pathname = `/v1/incident-cases/${encodeURIComponent(caseId)}/reports`;
    body = {
      actor_type: 'investigator',
      summary,
      report_sections: payload,
      recommendation: payload.recommendation || summary,
      root_cause: payload.root_cause || null,
      operator_question: payload.operator_question || null,
      confidence_level: payload.confidence_level || 'high',
      facts: Array.isArray(payload.facts) ? payload.facts : [],
      timeline: Array.isArray(payload.timeline) ? payload.timeline : [],
      alternatives: Array.isArray(payload.alternatives) ? payload.alternatives : [],
      test_plan: Array.isArray(payload.test_plan) ? payload.test_plan : [],
      idempotency_key: `report:${Date.now()}`,
    };
    break;
  }
  case 'decision': {
    const summary = requireValue(payload.summary || payload.text, 'summary');
    pathname = `/v1/incident-cases/${encodeURIComponent(caseId)}/decisions`;
    body = {
      actor_type: 'investigator',
      decision_kind: payload.decision_kind || kind || 'investigator_recommendation',
      summary,
      contract: payload,
      execution_scope: Array.isArray(payload.execution_scope) ? payload.execution_scope : [],
      test_plan: Array.isArray(payload.test_plan) ? payload.test_plan : [],
      idempotency_key: `decision:${Date.now()}`,
    };
    break;
  }
  case 'execution': {
    const summary = requireValue(payload.summary || payload.text, 'summary');
    pathname = `/v1/incident-cases/${encodeURIComponent(caseId)}/executions`;
    body = {
      actor_type: 'investigator',
      summary,
      status: payload.status || 'execution_in_progress',
      execution_report: payload,
      changed_files: Array.isArray(payload.changed_files) ? payload.changed_files : [],
      changed_configs: Array.isArray(payload.changed_configs) ? payload.changed_configs : [],
      changed_data_records: Array.isArray(payload.changed_data_records) ? payload.changed_data_records : [],
      command_results: Array.isArray(payload.command_results) ? payload.command_results : [],
      test_results: Array.isArray(payload.test_results) ? payload.test_results : [],
      deployments: Array.isArray(payload.deployments) ? payload.deployments : [],
      replays: Array.isArray(payload.replays) ? payload.replays : [],
      verification_results: Array.isArray(payload.verification_results) ? payload.verification_results : [],
      artifact_refs: Array.isArray(payload.artifact_refs) ? payload.artifact_refs : [],
      idempotency_key: `execution:${Date.now()}`,
    };
    break;
  }
  case 'complete': {
    const summary = requireValue(payload.summary || payload.text || 'הטיפול הושלם.', 'summary');
    pathname = `/v1/incident-cases/${encodeURIComponent(caseId)}/complete`;
    body = {
      actor_type: 'operator',
      summary,
      completion_reason: payload.completion_reason || summary,
      completion_type: payload.completion_type || kind || 'completed',
      idempotency_key: `complete:${Date.now()}`,
    };
    break;
  }
  case 'reopen': {
    const summary = requireValue(payload.summary || payload.text || 'התיק נפתח מחדש.', 'summary');
    pathname = `/v1/incident-cases/${encodeURIComponent(caseId)}/reopen`;
    body = {
      actor_type: 'operator',
      summary,
      reason: payload.reason || summary,
      idempotency_key: `reopen:${Date.now()}`,
    };
    break;
  }
  default:
    throw new Error(`unknown_command:${command}`);
}

const result = await requestJson(baseUrl, authToken, pathname, body);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
