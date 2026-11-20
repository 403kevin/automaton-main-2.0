export type RateSource = "facilitator" | "openrouter" | "search";

const counts: Record<RateSource, number> = { facilitator: 0, openrouter: 0, search: 0 };

/**
 * A 502 or 503 is retried for calls that only read or compute. The facilitator call moves money, and a gateway error does
 * not prove the settlement did not go through, so it is never retried on one (a 429 is still retried: it was not processed).
 */
const RETRY_GATEWAY_ERRORS: Record<RateSource, boolean> = { openrouter: true, search: true, facilitator: false };

function shouldRetry(status: number, source: RateSource): boolean {
  if (status === 429) return true;
  return (status === 502 || status === 503) && RETRY_GATEWAY_ERRORS[source];
}

export function noteGatewayError(source: RateSource, status: number): void {
  console.error(JSON.stringify({ level: "warn", msg: `HTTP ${status}`, source }));
}

export function noteRateLimit(source: RateSource): void {
  counts[source] += 1;
  console.error(JSON.stringify({ level: "warn", msg: "HTTP 429", source, count: counts[source] }));
}

export function rateLimitCounts(): Record<RateSource, number> {
  return { ...counts };
}

export function resetRateLimits(): void {
  counts.facilitator = 0;
  counts.openrouter = 0;
  counts.search = 0;
}

export async function fetchWithBackoff(
  url: string,
  init: RequestInit | undefined,
  source: RateSource,
  deps?: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> },
): Promise<Response> {
  const doFetch = deps?.fetch ?? fetch;
  const sleep = deps?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let delay = 1000;
  let response: Response | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await doFetch(url, init);
    if (!shouldRetry(response.status, source)) return response;
    if (response.status === 429) noteRateLimit(source);
    else noteGatewayError(source, response.status);
    if (attempt === 3) return response;
    const retryAfter = Number(response.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : delay;
    await sleep(wait);
    delay = Math.min(delay * 2, 30_000);
  }
  return response as Response;
}
