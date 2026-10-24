import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type Router } from 'express';
import { getRemoteHostConfig, type RemoteHostConfig } from './remoteHostRegistry.js';

type JsonObject = Record<string, any>;
type RemoteIncidentHost = Pick<RemoteHostConfig, 'id' | 'enabled' | 'token'>;

export interface IncidentRemoteGatewayDependencies {
  requestCanonical: (pathname: string, options?: RequestInit) => Promise<any>;
  getHost?: (serverId: string) => Promise<RemoteIncidentHost | null> | RemoteIncidentHost | null;
}

const MAX_BODY_BYTES = 128 * 1024;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
const SERVER_ID = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const CASE_PATH = /^\/v1\/incident-cases\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,199})\/(package|messages|reports|decisions|executions|complete|reopen)$/;

class GatewayError extends Error {
  constructor(readonly statusCode: number, code: string) {
    super(code);
  }
}

function gatewayError(statusCode: number, code: string): GatewayError {
  return new GatewayError(statusCode, code);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireIdentifier(value: unknown): void {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw gatewayError(400, 'incident_remote_identifier_invalid');
  }
}

function metadataFor(value: unknown, serverId: string, current: JsonObject = {}): JsonObject {
  if (value !== undefined && !isObject(value)) {
    throw gatewayError(400, 'incident_remote_metadata_invalid');
  }
  if (value && Object.hasOwn(value, 'codeAiServerId') && value.codeAiServerId !== serverId) {
    throw gatewayError(403, 'incident_remote_owner_change_forbidden');
  }
  return { ...current, ...value, codeAiServerId: serverId };
}

function boundedBody(body: unknown): asserts body is JsonObject {
  if (!isObject(body)) throw gatewayError(400, 'incident_remote_body_invalid');
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
    throw gatewayError(413, 'incident_remote_body_too_large');
  }
}

/** A narrow host-authenticated bridge; only the canonical requester owns backend credentials. */
export function createIncidentRemoteGateway(dependencies: IncidentRemoteGatewayDependencies): Router {
  const router = express.Router({ mergeParams: true });
  const getHost = dependencies.getHost || getRemoteHostConfig;
  const requestCanonical = dependencies.requestCanonical;

  router.use((req, res, next) => {
    void (async () => {
      const serverId = req.params.serverId;
      const authorization = req.get('authorization') || '';
      const bearer = /^Bearer ([^\s]+)$/i.exec(authorization);
      const host = typeof serverId === 'string' && SERVER_ID.test(serverId) && serverId !== 'local'
        ? await getHost(serverId)
        : null;
      const supplied = createHash('sha256').update(bearer?.[1] || '').digest();
      const expected = createHash('sha256').update(host?.token || '').digest();
      const matches = timingSafeEqual(supplied, expected);
      if (!bearer || authorization.length > 8192 || !host?.enabled || host.id !== serverId || !host.token || !matches) {
        throw gatewayError(401, 'incident_remote_unauthorized');
      }

      // Match the raw suffix, not Express's decoded path/query, so encodings,
      // duplicate query keys and traversal cannot become a different upstream URL.
      const list = /^\/v1\/incident-cases(?:\?status=[a-z_]{1,64})?$/.test(req.url);
      const match = CASE_PATH.exec(req.url);
      const creation = req.url === '/v1/incident-cases' && req.method === 'POST';
      if (!(req.method === 'GET' && (list || match?.[2] === 'package'))
        && !(req.method === 'POST' && (creation || (match && match[2] !== 'package')))) {
        throw gatewayError(404, 'incident_remote_route_not_found');
      }
      res.locals.incidentRemoteRoute = { serverId, caseId: match?.[1], creation };
      const length = req.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
        throw gatewayError(413, 'incident_remote_body_too_large');
      }
      if (req.method === 'GET' && (Number(length || 0) > 0 || req.get('transfer-encoding'))) {
        throw gatewayError(400, 'incident_remote_body_invalid');
      }
      if (req.method === 'POST' && !req.is('application/json')) {
        throw gatewayError(415, 'incident_remote_json_required');
      }
    })().then(() => next(), next);
  });

  router.use(express.json({ limit: MAX_BODY_BYTES, strict: true, inflate: false }));

  router.use((req, res, next) => {
    void (async () => {
      const { serverId, caseId, creation } = res.locals.incidentRemoteRoute as {
        serverId: string; caseId?: string; creation: boolean;
      };
      const readPackage = async (id: string, allowMissing = false) => {
        let result;
        try {
          result = await requestCanonical(`/v1/incident-cases/${id}/package`, { method: 'GET' });
        } catch (error: any) {
          if (allowMissing && error?.statusCode === 404) return null;
          if (error?.statusCode === 404) throw gatewayError(404, 'incident_remote_case_not_found');
          throw error;
        }
        const incidentCase = result?.package?.incident_case;
        if (!incidentCase) {
          if (allowMissing) return null;
          throw gatewayError(404, 'incident_remote_case_not_found');
        }
        if (incidentCase.metadata?.codeAiServerId !== serverId) {
          throw gatewayError(404, 'incident_remote_case_not_found');
        }
        return result;
      };

      if (req.method === 'GET') {
        if (caseId) return void res.json(await readPackage(caseId));
        const result = await requestCanonical(req.url, { method: 'GET' });
        return void res.json({
          ...result,
          incident_cases: Array.isArray(result?.incident_cases)
            ? result.incident_cases.filter((entry: any) => entry?.metadata?.codeAiServerId === serverId)
            : [],
        });
      }

      boundedBody(req.body);
      const body = { ...req.body };
      for (const field of ['investigator_profile_id', 'investigator_session_id']) {
        if (creation || Object.hasOwn(body, field)) requireIdentifier(body[field]);
      }
      if (creation) {
        body.metadata = metadataFor(body.metadata, serverId);
        if (body.incident_case_id !== undefined && body.incident_case_id !== null) {
          requireIdentifier(body.incident_case_id);
          const existing = await readPackage(body.incident_case_id, true);
          if (existing) {
            body.metadata = metadataFor(body.metadata, serverId, existing.package.incident_case.metadata);
          }
        }
        if (body.event_id !== undefined && (typeof body.event_id !== 'string'
          || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(body.event_id))) {
          throw gatewayError(400, 'incident_remote_event_id_invalid');
        }
        body.event_id = `remote:${serverId}:${body.event_id || randomUUID()}`;
      } else {
        const existing = await readPackage(caseId!);
        const metadata = existing.package.incident_case.metadata;
        if (body.case_patch !== undefined && !isObject(body.case_patch)) {
          throw gatewayError(400, 'incident_remote_case_patch_invalid');
        }
        const patch = { ...body.case_patch };
        for (const field of ['investigator_profile_id', 'investigator_session_id']) {
          if (Object.hasOwn(patch, field)) requireIdentifier(patch[field]);
        }
        if ((Object.hasOwn(body, 'incident_case_id') && body.incident_case_id !== caseId)
          || (Object.hasOwn(patch, 'incident_case_id') && patch.incident_case_id !== caseId)) {
          throw gatewayError(403, 'incident_remote_owner_change_forbidden');
        }
        if (Object.hasOwn(body, 'metadata')) body.metadata = metadataFor(body.metadata, serverId, metadata);
        if (Object.hasOwn(body, 'case_patch')) {
          body.case_patch = { ...patch, metadata: metadataFor(patch.metadata, serverId, metadata) };
        }
      }
      boundedBody(body);
      res.json(await requestCanonical(req.url, { method: 'POST', body: JSON.stringify(body) }));
    })().catch(next);
  });

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error?.statusCode || error?.status;
    const known = error instanceof GatewayError;
    res.status(known ? status : status === 413 ? 413 : status === 400 ? 400 : status === 415 ? 415 : 502).json({
      error: known ? error.message : status === 413 ? 'incident_remote_body_too_large'
        : status === 400 ? 'incident_remote_body_invalid'
          : status === 415 ? 'incident_remote_json_required' : 'incident_remote_upstream_failed',
    });
  };
  router.use(errors);
  return router;
}
