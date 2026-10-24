/** Only retry an explicit pre-handler maintenance refusal. A network failure
 * cannot prove a write was not accepted, so it is deliberately not replayed. */
export async function fetchWithDeploymentRetry(
  fetcher: (input: RequestInfo, init?: RequestInit) => Promise<Response>,
  input: RequestInfo,
  init?: RequestInit,
  options: { wait?: (milliseconds: number, signal?: AbortSignal | null) => Promise<void>; maxWaitMs?: number } = {},
): Promise<Response> {
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const body = init?.body;
  // Streams, FormData and Request bodies may be consumed; never replay them.
  const repeatable = (method === 'GET' || method === 'HEAD')
    || (typeof body === 'string' && hasStableRequestId(body));
  const wait = options.wait || waitForRetry;
  const deadline = Date.now() + (options.maxWaitMs ?? 120_000);
  for (;;) {
    init?.signal?.throwIfAborted();
    const response = await fetcher(input, init);
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
