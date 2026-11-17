export type RateSource = "facilitator" | "openrouter" | "search";

const counts: Record<RateSource, number> = { facilitator: 0, openrouter: 0, search: 0 };

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
    if (response.status !== 429) return response;
    noteRateLimit(source);
    if (attempt === 3) return response;
    const retryAfter = Number(response.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : delay;
    await sleep(wait);
    delay = Math.min(delay * 2, 30_000);
  }
  return response as Response;
}
