import { ensureRemoteHostEndpoint, type RemoteAgentEndpoint } from './remoteHostRegistry.js';

export interface IncidentWakeTaskInput {
  taskType: string;
  caseId: string;
  idempotencyKey?: string;
  decisionId?: string;
}

export interface IncidentWakeResult {
  queue_item_id: string;
  queue_status: string;
  session_id: string;
  profile_id: string;
  context_file_path: string;
}

export interface IncidentRemoteWakeDependencies {
  ensureEndpoint?: (serverId: string) => Promise<RemoteAgentEndpoint>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

class IncidentRemoteWakeError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}

const RESULT_FIELDS = ['queue_item_id', 'queue_status', 'session_id', 'profile_id', 'context_file_path'] as const;

/** One authenticated mutation only. Admission retries belong to the canonical decision/queue identity. */
export function createIncidentRemoteWake(dependencies: IncidentRemoteWakeDependencies = {}) {
  const ensureEndpoint = dependencies.ensureEndpoint || ensureRemoteHostEndpoint;
  const fetchRemote = dependencies.fetch || ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const configuredTimeout = dependencies.timeoutMs ?? 30_000;
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.max(1, Math.min(configuredTimeout, 60_000)) : 30_000;

  return async (serverId: string, payload: IncidentWakeTaskInput): Promise<IncidentWakeResult> => {
    if (!/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(serverId) || serverId === 'local') {
      throw new IncidentRemoteWakeError('incident_remote_wake_server_invalid', 400);
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(payload.caseId)) {
      throw new IncidentRemoteWakeError('incident_remote_wake_case_invalid', 400);
    }
    const controller = new AbortController();
    const timeoutError = new IncidentRemoteWakeError('incident_remote_wake_timeout', 504);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let endpointReady = false;
    const dispatch = async () => {
      try {
        const endpoint = await ensureEndpoint(serverId);
        endpointReady = true;
        // Endpoint discovery can finish after the caller's deadline. Never issue
        // a late mutation once that caller has already received a timeout.
        if (controller.signal.aborted) throw timeoutError;
        const hostname = endpoint.hostname.includes(':') && !endpoint.hostname.startsWith('[')
          ? `[${endpoint.hostname}]`
          : endpoint.hostname;
        const response = await fetchRemote(`http://${hostname}:${endpoint.port}/api/codex/incident-cases/${encodeURIComponent(payload.caseId)}/wake`, {
          method: 'POST',
          credentials: 'omit',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-code-ai-remote-token': endpoint.token,
          },
          body: JSON.stringify({
            taskType: payload.taskType,
            ...(payload.idempotencyKey !== undefined ? { idempotencyKey: payload.idempotencyKey } : {}),
            ...(payload.decisionId !== undefined ? { decisionId: payload.decisionId } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          // Never expose arbitrary upstream bodies (or credential-bearing transport errors).
          throw new IncidentRemoteWakeError(`incident_remote_wake_http_${response.status}`, response.status >= 400 && response.status <= 599 ? response.status : 502);
        }
        const body = await response.json();
        const result = {} as IncidentWakeResult;
        for (const field of RESULT_FIELDS) {
          const value = body?.[field];
          if (typeof value !== 'string' || !value.trim() || value.length > 4_096 || (endpoint.token && value.includes(endpoint.token))) {
            throw new IncidentRemoteWakeError('incident_remote_wake_response_invalid');
          }
          result[field] = value;
        }
        return result;
      } catch (error) {
        if (error instanceof IncidentRemoteWakeError) throw error;
        if (controller.signal.aborted) throw timeoutError;
        throw new IncidentRemoteWakeError(endpointReady ? 'incident_remote_wake_failed' : 'incident_remote_wake_endpoint_unavailable');
      }
    };
    try {
      return await Promise.race([
        dispatch(),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            reject(timeoutError);
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}

export const wakeRemoteIncidentSession = createIncidentRemoteWake();
