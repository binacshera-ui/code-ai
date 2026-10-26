/** Reads may recover from a transient gateway/network outage. Writes require
 * explicit pre-handler nonacceptance proof; ambiguous writes are never replayed. */
export async function fetchWithDeploymentRetry(
  fetcher: (input: RequestInfo, init?: RequestInit) => Promise<Response>,
  input: RequestInfo,
  init?: RequestInit,
  options: { wait?: (milliseconds: number, signal?: AbortSignal | null) => Promise<void>; maxWaitMs?: number } = {},
): Promise<Response> {
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const body = init?.body;
  const readOnly = method === 'GET' || method === 'HEAD';
  // Streams, FormData and Request bodies may be consumed; never replay them.
  const repeatable = (method === 'GET' || method === 'HEAD')
    || (typeof body === 'string' && hasStableRequestId(body));
  const wait = options.wait || waitForRetry;
  const deadline = Date.now() + (options.maxWaitMs ?? 120_000);
  let readRetries = 0;
  for (;;) {
    init?.signal?.throwIfAborted();
    let response: Response;
    try { response = await fetcher(input, init); }
    catch (error) {
      init?.signal?.throwIfAborted();
      if (!readOnly || !(error instanceof TypeError) || readRetries >= 3 || Date.now() >= deadline) throw error;
      readRetries++;
      await wait(Math.min(2_000, Math.max(0, deadline - Date.now())), init?.signal);
      continue;
    }
    if (readOnly && [502, 503, 504].includes(response.status) && readRetries < 3 && Date.now() < deadline) {
      readRetries++;
      await response.body?.cancel();
      await wait(Math.min(2_000, Math.max(0, deadline - Date.now())), init?.signal);
      continue;
    }
    // Exhausted ordinary read recovery must return the actual response intact.
    if (readOnly) return response;
    if (!repeatable || response.status !== 503 || Date.now() >= deadline) return response;
    if (!(response.headers.get('content-type') || '').includes('application/json')) return response;
    let refusal: unknown;
    try { refusal = await response.clone().json(); } catch { return response; }
    if (!refusal || typeof refusal !== 'object'
      || (refusal as { code?: string }).code !== 'CODE_AI_DEPLOYMENT_DRAIN'
      || (refusal as { retryable?: boolean }).retryable !== true) return response;
    const seconds = Number(response.headers.get('Retry-After'));
    const delay = Number.isFinite(seconds) && seconds > 0 ? Math.min(10_000, seconds * 1_000) : 2_000;
    await response.body?.cancel();
    await wait(Math.min(delay, Math.max(0, deadline - Date.now())), init?.signal);
  }
}

function hasStableRequestId(body: string): boolean {
  try {
    const value = JSON.parse(body);
    return typeof value?.clientRequestId === 'string' && value.clientRequestId.trim().length > 0;
  } catch { return false; }
}

function waitForRetry(milliseconds: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const finished = () => { signal?.removeEventListener('abort', aborted); resolve(); };
    const timer = setTimeout(finished, milliseconds);
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(signal?.reason); };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
