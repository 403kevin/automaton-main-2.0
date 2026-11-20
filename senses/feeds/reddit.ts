import { SeeError } from "../src/contract.ts";
import { fetchPublic, type FeedContext, type PublicResponse } from "./fetch.ts";
import { asArray, asRecord, capItems, feedItem, numberField, optionString, stringField, toIso } from "./text.ts";
import { DEFAULT_REDDIT_USER_AGENT, FEED_TIMEOUT_MS, type FeedItem, type FeedResult } from "./types.ts";

/** At most one Reddit request every two seconds, process-wide. */
export const REDDIT_MIN_INTERVAL_MS = 2_000;

let nextRedditAt = 0;

export function resetRedditSchedule(): void {
  nextRedditAt = 0;
}

export async function paceReddit(now: () => number, sleep: (ms: number) => Promise<void>): Promise<void> {
  const start = now();
  const wait = Math.max(0, nextRedditAt - start);
  if (wait > 0) await sleep(wait);
  nextRedditAt = Math.max(nextRedditAt, now()) + REDDIT_MIN_INTERVAL_MS;
}

export function parseReddit(body: string): FeedItem[] {
  const parsed = JSON.parse(body) as unknown;
  const listings = Array.isArray(parsed) ? parsed : [parsed];
  const items: FeedItem[] = [];
  for (const listing of listings) {
    const data = asRecord(asRecord(listing)?.data);
    for (const child of asArray(data?.children)) {
      const node = asRecord(child);
      const record = asRecord(node?.data);
      if (!node || !record) continue;
      const kind = stringField(node, "kind");
      const id = stringField(record, "name") || (kind && stringField(record, "id") ? `${kind}_${stringField(record, "id")}` : stringField(record, "id"));
      if (!id) continue;
      const permalink = stringField(record, "permalink");
      const external = stringField(record, "url");
      const redditUrl = permalink ? `https://www.reddit.com${permalink.startsWith("/") ? permalink : `/${permalink}`}` : "";
      const url = kind === "t1" ? redditUrl : /^https?:\/\//i.test(external) ? external : redditUrl;
      if (!url) continue;
      const created = numberField(record, "created_utc");
      items.push(
        feedItem({
          source: "reddit",
          id,
          title: stringField(record, "title", "link_title") || "Comment",
          url,
          text: stringField(record, "selftext", "body"),
          author: stringField(record, "author") || undefined,
          score: numberField(record, "score"),
          created_at: created !== undefined ? toIso(new Date(created * 1000).toISOString()) : undefined,
        }),
      );
    }
  }
  return capItems(items);
}

export async function readReddit(ctx: FeedContext): Promise<FeedResult> {
  const target = redditUrl(ctx.query, ctx.options);
  const paced: FeedContext = {
    ...ctx,
    userAgent: cleanAgent(ctx.userAgent),
    beforeRequest: () => paceReddit(ctx.now, ctx.sleep),
  };
  const first = await fetchPublic(target, paced, { accept: "application/json" });
  if (first.status !== 429) return interpretReddit(first);
  const wait = retryAfterMs(first.headers, ctx.now());
  // One backoff. A Retry-After past the feed timeout means we do not poke again.
  if (wait > FEED_TIMEOUT_MS) return block(first.status, "reddit rate limited");
  if (wait > 0) await ctx.sleep(wait);
  const second = await fetchPublic(target, paced, { accept: "application/json" });
  return interpretReddit(second);
}

function interpretReddit(response: PublicResponse): FeedResult {
  if (response.status === 403 || response.status === 429 || isBlockedHtml(response)) {
    return block(response.status, blockReason(response));
  }
  if (response.status >= 400) throw new SeeError(`reddit returned HTTP ${response.status}.`, 502);
  return { items: parseReddit(response.body) };
}

function block(status: number, reason: string): FeedResult {
  return { blocked: true, status, reason, items: [] };
}

function blockReason(response: PublicResponse): string {
  if (response.status === 429) return "reddit rate limited";
  if (response.status === 403) return "reddit forbidden";
  return "blocked HTML";
}

function isBlockedHtml(response: PublicResponse): boolean {
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("text/html") || type.includes("application/xhtml")) return true;
  const body = response.body.trimStart().slice(0, 300).toLowerCase();
  return body.startsWith("<!doctype html") || body.startsWith("<html");
}

export function retryAfterMs(headers: Headers, now: number): number {
  const raw = headers.get("retry-after")?.trim() ?? "";
  if (!raw) return REDDIT_MIN_INTERVAL_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - now);
  return REDDIT_MIN_INTERVAL_MS;
}

export function redditUrl(query: string, options: Record<string, unknown>): string {
  const sub = subreddit(optionString(options, "subreddit", "sub"));
  const kind = optionString(options, "kind", "sort", "listing").toLowerCase();
  if (kind === "comments" || options.comments === true) {
    const id = postId(optionString(options, "post", "id") || query);
    const path = sub ? `/r/${sub}/comments/${id}.json` : `/comments/${id}.json`;
    return `https://www.reddit.com${path}?limit=25&raw_json=1`;
  }
  if (kind === "new") {
    if (!sub) throw new SeeError("reddit new listing needs a subreddit.", 400);
    return `https://www.reddit.com/r/${sub}/new.json?limit=25&raw_json=1`;
  }
  const q = encodeURIComponent(query);
  if (sub) return `https://www.reddit.com/r/${sub}/search.json?q=${q}&restrict_sr=1&limit=25&sort=relevance&raw_json=1`;
  return `https://www.reddit.com/search.json?q=${q}&limit=25&raw_json=1`;
}

function subreddit(value: string): string {
  if (!value) return "";
  if (!/^[A-Za-z0-9_]{2,21}$/.test(value)) throw new SeeError("subreddit is not a valid name.", 400);
  return value;
}

function postId(value: string): string {
  const id = value.trim().replace(/^t3_/, "");
  if (!/^[a-z0-9]{3,12}$/i.test(id)) throw new SeeError("reddit post id is not valid.", 400);
  return id;
}

function cleanAgent(value: string): string {
  const cleaned = value.replace(/[\r\n]/g, "").trim();
  return cleaned || DEFAULT_REDDIT_USER_AGENT;
}
