import { Router, Request, Response } from 'express';
import { requireGeminiObservatoryApiAccess } from './geminiObservatoryAccess.js';

const router = Router();
const GEMINI_CONVERSATION_SERVICE_URL = (
  process.env.GEMINI_CONVERSATION_SERVICE_URL
  || process.env.GEMINI_SERVICE_URL
  || 'http://localhost:3002'
).trim().replace(/\/+$/, '');
const GEMINI_PROXY_TIMEOUT_MS = Number(process.env.GEMINI_CONVERSATION_PROXY_TIMEOUT_MS || 60_000);

const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = new Set([
  'authorization',
  'api_key',
  'apikey',
  'secret',
  'access_token',
  'refresh_token',
  'token',
  'id_token',
  'oidctoken',
  'privatekey',
  'password',
]);
const SIGNED_QUERY_FRAGMENTS = ['x-amz-signature', 'x-amz-credential', 'x-amz-security-token', 'googleaccessid', 'signature', 'expires', 'token'];

function isSensitiveKey(normalizedKey: string) {
  if (SENSITIVE_KEYS.has(normalizedKey)) {
    return true;
  }

  if (normalizedKey.endsWith('_token')) {
    return !normalizedKey.endsWith('prompt_tokens')
      && !normalizedKey.endsWith('completion_tokens')
      && !normalizedKey.endsWith('total_tokens');
  }

  return false;
}

function buildServiceUrl(pathname: string, query?: Request['query']) {
  const base = new URL(`${GEMINI_CONVERSATION_SERVICE_URL}${pathname}`);
  if (!query) {
    return base.toString();
  }

  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item == null) continue;
        base.searchParams.append(key, String(item));
      }
      continue;
    }

    if (value == null) continue;
    base.searchParams.set(key, String(value));
  }

  return base.toString();
}

function sanitizeSignedUrl(value: string) {
  try {
    const parsed = new URL(value);
    const hasSensitiveParams = [...parsed.searchParams.keys()].some((key) => {
      const normalized = key.trim().toLowerCase();
      return SIGNED_QUERY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
    });

    if (!hasSensitiveParams) {
      return value;
    }

    return `${parsed.origin}${parsed.pathname}?signature=${encodeURIComponent(REDACTED)}`;
  } catch {
    return value;
  }
}

function sanitizePayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayload(item));
  }

  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      return sanitizeSignedUrl(value);
    }
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.trim().toLowerCase();
    if (isSensitiveKey(normalizedKey)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = sanitizePayload(rawValue);
  }
  return output;
}

async function fetchGeminiServiceJson(pathname: string, options?: {
  method?: string;
  query?: Request['query'];
  body?: unknown;
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_PROXY_TIMEOUT_MS);

  try {
    const response = await fetch(buildServiceUrl(pathname, options?.query), {
      method: options?.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      body: options?.body == null ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });

    const rawText = await response.text();
    const trimmed = rawText.trim();
    const contentType = response.headers.get('content-type') || '';
    const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[') || contentType.includes('application/json');
    const payload = looksLikeJson && trimmed ? JSON.parse(trimmed) : trimmed;

    if (!response.ok) {
      const errorMessage = typeof payload === 'object' && payload && 'error' in payload
        ? String((payload as { error?: string }).error || 'Gemini service request failed')
        : `Gemini service request failed with status ${response.status}`;
      const error = new Error(errorMessage) as Error & {
        statusCode?: number;
        payload?: unknown;
      };
      error.statusCode = response.status;
      error.payload = payload;
      throw error;
    }

    return sanitizePayload(payload);
  } finally {
    clearTimeout(timeoutId);
  }
}

router.use(requireGeminiObservatoryApiAccess);

router.get('/conversations', async (req: Request, res: Response) => {
  try {
    const data = await fetchGeminiServiceJson('/conversations', { query: req.query });
    res.json(data);
  } catch (error) {
    res.status((error as { statusCode?: number }).statusCode || 502).json({
      error: error instanceof Error ? error.message : 'Failed to load Gemini conversations',
    });
  }
});

router.get('/conversations/:conversationId', async (req: Request, res: Response) => {
  try {
    const data = await fetchGeminiServiceJson(`/conversations/${encodeURIComponent(req.params.conversationId)}`, {
      query: req.query,
    });
    res.json(data);
  } catch (error) {
    res.status((error as { statusCode?: number }).statusCode || 502).json({
      error: error instanceof Error ? error.message : 'Failed to load Gemini conversation detail',
    });
  }
});

router.get('/conversations/:conversationId/jobs', async (req: Request, res: Response) => {
  try {
    const data = await fetchGeminiServiceJson(`/conversations/${encodeURIComponent(req.params.conversationId)}/jobs`, {
      query: req.query,
    });
    res.json(data);
  } catch (error) {
    res.status((error as { statusCode?: number }).statusCode || 502).json({
      error: error instanceof Error ? error.message : 'Failed to load Gemini conversation jobs',
    });
  }
});

router.post('/conversations/:conversationId/restart', async (req: Request, res: Response) => {
  try {
    const data = await fetchGeminiServiceJson('/restart', {
      method: 'POST',
      body: {
        ...req.body,
        conversation_id: req.params.conversationId,
      },
    });
    res.json(data);
  } catch (error) {
    res.status((error as { statusCode?: number }).statusCode || 502).json({
      error: error instanceof Error ? error.message : 'Failed to restart Gemini conversation',
    });
  }
});

router.post('/conversations/:conversationId/compress', async (req: Request, res: Response) => {
  try {
    const data = await fetchGeminiServiceJson('/compress', {
      method: 'POST',
      body: {
        ...req.body,
        conversation_id: req.params.conversationId,
      },
    });
    res.json(data);
  } catch (error) {
    res.status((error as { statusCode?: number }).statusCode || 502).json({
      error: error instanceof Error ? error.message : 'Failed to compress Gemini conversation',
    });
  }
});

router.post('/conversations/:conversationId/export', async (req: Request, res: Response) => {
  try {
    const data = await fetchGeminiServiceJson('/export-history', {
      method: 'POST',
      body: {
        ...req.body,
        conversation_ids: [req.params.conversationId],
      },
    });
    res.json(data);
  } catch (error) {
    res.status((error as { statusCode?: number }).statusCode || 502).json({
      error: error instanceof Error ? error.message : 'Failed to export Gemini conversation',
    });
  }
});

router.post('/export-history', async (req: Request, res: Response) => {
  try {
    const data = await fetchGeminiServiceJson('/export-history', {
      method: 'POST',
      body: req.body,
    });
    res.json(data);
  } catch (error) {
    res.status((error as { statusCode?: number }).statusCode || 502).json({
      error: error instanceof Error ? error.message : 'Failed to export Gemini histories',
    });
  }
});

router.get('/jobs', async (req: Request, res: Response) => {
  try {
    const data = await fetchGeminiServiceJson('/jobs', { query: req.query });
    res.json(data);
  } catch (error) {
    res.status((error as { statusCode?: number }).statusCode || 502).json({
      error: error instanceof Error ? error.message : 'Failed to load Gemini jobs',
    });
  }
});

router.get('/jobs/:jobId/detail', async (req: Request, res: Response) => {
  try {
    const data = await fetchGeminiServiceJson(`/jobs/${encodeURIComponent(req.params.jobId)}/detail`, {
      query: req.query,
    });
    res.json(data);
  } catch (error) {
    res.status((error as { statusCode?: number }).statusCode || 502).json({
      error: error instanceof Error ? error.message : 'Failed to load Gemini job detail',
    });
  }
});

router.get('/jobs/:jobId/result', async (req: Request, res: Response) => {
  try {
    const data = await fetchGeminiServiceJson(`/result/${encodeURIComponent(req.params.jobId)}`, {
      query: req.query,
    });
    res.json(data);
  } catch (error) {
    res.status((error as { statusCode?: number }).statusCode || 502).json({
      error: error instanceof Error ? error.message : 'Failed to load Gemini job result',
    });
  }
});

export default router;
