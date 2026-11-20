import { SeeError } from "../src/contract.ts";
import { MAX_BODY_BYTES, reviewHop, type ResolveHost } from "../src/safety.ts";
import type { FeedItem } from "./types.ts";
import { FEED_TIMEOUT_MS } from "./types.ts";

export interface FeedContext {
  query: string;
  options: Record<string, unknown>;
  denyHosts: readonly string[];
  resolveHost: ResolveHost;
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  userAgent: string;
  timeoutMs?: number;
  beforeRequest?: () => Promise<void>;
}

export interface PublicResponse {
  status: number;
  headers: Headers;
  body: string;
  finalUrl: string;
}

const MAX_REDIRECTS = 5;

export async function fetchPublic(rawUrl: string, ctx: FeedContext, headers: Record<string, string> = {}): Promise<PublicResponse> {
  const timeoutMs = ctx.timeoutMs ?? FEED_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let current = rawUrl;
  const seen = new Set<string>();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (seen.has(current)) throw new SeeError("Redirect loop.", 400);
    seen.add(current);
    const verdict = await reviewHop(current, ctx.denyHosts, ctx.resolveHost);
    if (!verdict.allowed) throw new SeeError(verdict.reason, 400);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SeeError("Feed request timed out.", 504);
    if (ctx.beforeRequest) await ctx.beforeRequest();
    let response: Response;
    try {
      response = await ctx.fetchImpl(current, {
        redirect: "manual",
        headers: {
          accept: "application/json, application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
          "user-agent": ctx.userAgent,
          ...headers,
        },
        signal: AbortSignal.timeout(remaining),
      });
    } catch (error) {
      if (error instanceof SeeError) throw error;
      const message = error instanceof Error ? error.message : "Feed request failed.";
      throw new SeeError(message, 502);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new SeeError("Redirect is missing a location.", 400);
      if (hop === MAX_REDIRECTS) throw new SeeError("Too many redirects.", 400);
      try {
        current = new URL(location, current).href;
      } catch {
        throw new SeeError("Redirect location is not a valid URL.", 400);
      }
      continue;
    }
    const body = await readCapped(response, MAX_BODY_BYTES);
    return { status: response.status, headers: response.headers, body, finalUrl: current };
  }
  throw new SeeError("Too many redirects.", 400);
}

export async function readCapped(response: Response, limit: number): Promise<string> {
  const advertised = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(advertised) && advertised > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new SeeError("Response body exceeds 2 MB.", 413);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new SeeError("Response body exceeds 2 MB.", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Drop item URLs that fail the same hop check as see_page. */
export async function keepPublicItems(items: FeedItem[], ctx: FeedContext): Promise<FeedItem[]> {
  const kept: FeedItem[] = [];
  for (const item of items) {
    if (!item.url) continue;
    const verdict = await reviewHop(item.url, ctx.denyHosts, ctx.resolveHost);
    if (!verdict.allowed) continue;
    kept.push(item);
  }
  return kept;
}

export function requireOk(response: PublicResponse, source: string): void {
  if (response.status >= 400) throw new SeeError(`${source} returned HTTP ${response.status}.`, 502);
}
