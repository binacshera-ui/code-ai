import type {
  GeminiConversationDetailResponse,
  GeminiConversationsListResponse,
  GeminiExportResponse,
  GeminiJobDetailResponse,
} from './types';

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const rawText = await response.text();
  const trimmed = rawText.trim();
  const contentType = response.headers.get('content-type') || '';
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[') || contentType.includes('application/json');

  if (!looksLikeJson) {
    throw new Error(`Expected JSON response from ${typeof input === 'string' ? input : 'request'}`);
  }

  const data = trimmed ? JSON.parse(trimmed) : null;
  if (!response.ok) {
    throw new Error((data as { error?: string } | null)?.error || 'Request failed');
  }

  return data as T;
}

function buildQueryString(query: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

export function listGeminiConversations(query: {
  q?: string;
  stage?: string;
  provider?: string;
  model?: string;
  hasFiles?: boolean | null;
  hasToolCalls?: boolean | null;
  historyOffloaded?: boolean | null;
  published?: boolean | null;
  cursor?: string | null;
  limit?: number;
  sortBy?: string;
}) {
  return fetchJson<GeminiConversationsListResponse>(`/api/gemini-conversations/conversations${buildQueryString(query)}`);
}

export function getGeminiConversationDetail(conversationId: string, includeSystem = false) {
  return fetchJson<GeminiConversationDetailResponse>(
    `/api/gemini-conversations/conversations/${encodeURIComponent(conversationId)}${buildQueryString({ includeSystem })}`
  );
}

export function restartGeminiConversation(conversationId: string) {
  return fetchJson<{ success?: boolean; message?: string }>(
    `/api/gemini-conversations/conversations/${encodeURIComponent(conversationId)}/restart`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }
  );
}

export function compressGeminiConversation(conversationId: string) {
  return fetchJson<{ success?: boolean; message?: string; details?: string }>(
    `/api/gemini-conversations/conversations/${encodeURIComponent(conversationId)}/compress`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        keep_last_n: 24,
        min_to_compress: 12,
        batch_size: 10,
        preserve_recent_tool_messages: 3,
      }),
    }
  );
}

export function exportGeminiConversation(conversationId: string, includeSystem = true) {
  return fetchJson<GeminiExportResponse>(
    `/api/gemini-conversations/conversations/${encodeURIComponent(conversationId)}/export`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system: includeSystem,
      }),
    }
  );
}

export function getGeminiJobDetail(jobId: string, includeSystem = false) {
  return fetchJson<GeminiJobDetailResponse>(
    `/api/gemini-conversations/jobs/${encodeURIComponent(jobId)}/detail${buildQueryString({ includeSystem })}`
  );
}
