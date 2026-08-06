import type { NextFunction, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import http from 'http';
import {
  ensureRemoteHostEndpoint,
  getRemoteHostConfig,
  isLocalCodeAiServerId,
} from './remoteHostRegistry.js';

const SERVER_HEADER = 'x-code-ai-server-id';
const REMOTE_TOKEN_HEADER = 'x-code-ai-remote-token';
const PROXIED_OWNER_HEADER = 'x-code-ai-proxied-owner';
const CONTROL_PLANE_PATHS = new Set([
  '/servers',
  '/auth/status',
  '/device-unlock',
  '/logout',
]);

type AccessMiddleware = (req: Request, res: Response, next: NextFunction) => void;

function readHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function isControlPlaneRequest(req: Request): boolean {
  const path = req.path || '/';
  if (CONTROL_PLANE_PATHS.has(path)) {
    return true;
  }
  return path.startsWith('/servers/');
}

function isPublicSessionTriggerRequest(req: Request): boolean {
  return (
    req.method === 'POST'
    && /^\/session-triggers\/[^/]+\/fire$/.test(req.path || '')
  );
}

function readRequestedServerId(req: Request): string {
  const headerServerId = readHeaderValue(req.headers[SERVER_HEADER]).trim().toLowerCase();
  if (headerServerId) {
    return headerServerId;
  }

  // External session triggers cannot set custom browser headers. The server
  // query parameter is accepted only on the token-protected trigger endpoint;
  // all other routes require the dedicated header.
  if (isPublicSessionTriggerRequest(req) && typeof req.query.server === 'string') {
    return req.query.server.trim().toLowerCase();
  }
  return '';
}

function buildForwardHeaders(req: Request, token: string, body: Buffer | null): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const normalizedName = name.toLowerCase();
    if (
      value === undefined
      || normalizedName === 'host'
      || normalizedName === 'cookie'
      || normalizedName === 'authorization'
      || normalizedName === 'proxy-authorization'
      || normalizedName === 'connection'
      || normalizedName === 'content-length'
      || normalizedName === SERVER_HEADER
      || normalizedName === REMOTE_TOKEN_HEADER
      || normalizedName === PROXIED_OWNER_HEADER
    ) {
      continue;
    }
    headers[name] = value;
  }

  headers[REMOTE_TOKEN_HEADER] = token;
  headers[PROXIED_OWNER_HEADER] = createHmac('sha256', token)
    .update(String((req as any).codexAuth?.user?.id || 'code-ai-user'))
    .digest('hex');
  headers['x-code-ai-proxied-by'] = 'code-ai-control-plane';
  headers['x-forwarded-for'] = req.ip || req.socket.remoteAddress || '';
  if (body) {
    headers['content-length'] = String(body.length);
  }
  return headers;
}

function serializeParsedBody(req: Request): Buffer | null {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return null;
  }

  const contentType = readHeaderValue(req.headers['content-type']).toLowerCase();
  if (contentType.includes('application/json')) {
    return Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams();
    if (req.body && typeof req.body === 'object') {
      for (const [key, value] of Object.entries(req.body)) {
        if (Array.isArray(value)) {
          value.forEach((entry) => params.append(key, String(entry)));
        } else if (value !== undefined && value !== null) {
          params.append(key, String(value));
        }
      }
    }
    return Buffer.from(params.toString(), 'utf8');
  }
  return null;
}

function buildRemoteRequestPath(req: Request): string {
  const originalPath = req.originalUrl.startsWith('/api/codex')
    ? req.originalUrl
    : `/api/codex${req.url}`;
  if (!isPublicSessionTriggerRequest(req)) {
    return originalPath;
  }

  // `server` belongs to the control plane only. Leaving it in the forwarded
  // URL would make a sidecar interpret the request as another remote hop.
  const parsed = new URL(originalPath, 'http://code-ai.internal');
  parsed.searchParams.delete('server');
  return `${parsed.pathname}${parsed.search}`;
}

function copyResponseHeaders(remoteResponse: http.IncomingMessage, res: Response): void {
  for (const [name, value] of Object.entries(remoteResponse.headers)) {
    const normalizedName = name.toLowerCase();
    if (
      value === undefined
      || normalizedName === 'set-cookie'
      || normalizedName === 'connection'
      || normalizedName === 'transfer-encoding'
      || normalizedName.startsWith('access-control-')
    ) {
      continue;
    }
    res.setHeader(name, value);
  }
}

async function proxyRequest(req: Request, res: Response, serverId: string): Promise<void> {
  const host = await getRemoteHostConfig(serverId);
  if (!host) {
    res.status(404).json({ error: `השרת שנבחר אינו מוגדר או כבוי: ${serverId}` });
    return;
  }

  const endpoint = await ensureRemoteHostEndpoint(host.id);
  const parsedBody = serializeParsedBody(req);
  const requestPath = buildRemoteRequestPath(req);

  await new Promise<void>((resolve) => {
    let responseStarted = false;
    const remoteRequest = http.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: requestPath,
      method: req.method,
      headers: buildForwardHeaders(req, endpoint.token, parsedBody),
      agent: false,
    }, (remoteResponse) => {
      responseStarted = true;
      res.status(remoteResponse.statusCode || 502);
      copyResponseHeaders(remoteResponse, res);
      remoteResponse.once('error', (error) => {
        if (!res.headersSent) {
          res.status(502).json({ error: `החיבור לשרת המרוחק נקטע: ${error.message}` });
        } else {
          res.destroy(error);
        }
        resolve();
      });
      remoteResponse.once('end', resolve);
      remoteResponse.pipe(res);
    });

    remoteRequest.setTimeout(0);
    remoteRequest.once('error', (error) => {
      if (!responseStarted && !res.headersSent) {
        res.status(502).json({
          error: `לא ניתן להעביר את הבקשה לשרת ${host.label}: ${error.message}`,
        });
      } else if (!res.writableEnded) {
        res.destroy(error);
      }
      resolve();
    });

    req.once('aborted', () => {
      remoteRequest.destroy(new Error('Client request was aborted'));
    });

    if (parsedBody) {
      remoteRequest.end(parsedBody);
      return;
    }

    const contentType = readHeaderValue(req.headers['content-type']).toLowerCase();
    const shouldStreamOriginalBody = (
      req.method !== 'GET'
      && req.method !== 'HEAD'
      && !contentType.includes('application/json')
      && !contentType.includes('application/x-www-form-urlencoded')
    );
    if (shouldStreamOriginalBody) {
      req.pipe(remoteRequest);
      return;
    }
    remoteRequest.end();
  });
}

export function createRemoteHostProxyMiddleware(requireAccess: AccessMiddleware) {
  return function remoteHostProxyMiddleware(req: Request, res: Response, next: NextFunction) {
    const serverId = readRequestedServerId(req);
    if (isLocalCodeAiServerId(serverId) || isControlPlaneRequest(req)) {
      next();
      return;
    }

    if (isPublicSessionTriggerRequest(req)) {
      void proxyRequest(req, res, serverId).catch((error) => {
        if (!res.headersSent) {
          res.status(502).json({
            error: error instanceof Error ? error.message : 'Remote server proxy failed',
          });
          return;
        }
        res.destroy(error instanceof Error ? error : undefined);
      });
      return;
    }

    requireAccess(req, res, () => {
      void proxyRequest(req, res, serverId).catch((error) => {
        if (!res.headersSent) {
          res.status(502).json({
            error: error instanceof Error ? error.message : 'Remote server proxy failed',
          });
          return;
        }
        res.destroy(error instanceof Error ? error : undefined);
      });
    });
  };
}

export function requireRemoteAgentToken(req: Request, res: Response, next: NextFunction): void {
  const expectedToken = process.env.CODEX_REMOTE_AGENT_TOKEN?.trim() || '';
  if (!expectedToken) {
    next();
    return;
  }

  const incomingToken = readHeaderValue(req.headers[REMOTE_TOKEN_HEADER]);
  const expectedBuffer = Buffer.from(expectedToken);
  const incomingBuffer = Buffer.from(incomingToken);
  const matches = expectedBuffer.length === incomingBuffer.length
    && expectedBuffer.length > 0
    && timingSafeEqual(expectedBuffer, incomingBuffer);

  if (!matches) {
    res.status(401).json({ error: 'Remote agent token is invalid' });
    return;
  }

  (req as any).codeAiRemoteAgentAuthenticated = true;
  next();
}
