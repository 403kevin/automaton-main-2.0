import { SeeError } from "../src/contract.ts";
import { fetchPublic, type FeedContext, type PublicResponse } from "./fetch.ts";
import { asArray, asRecord, capItems, feedItem, numberField, stringField, toIso } from "./text.ts";
import type { FeedItem, FeedResult } from "./types.ts";

const PRIMARY = "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts";
const FALLBACK = "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts";
export const BLUESKY_AUTH_REASON = "unavailable: requires auth";

export function parseBluesky(body: string): FeedItem[] {
  const parsed = asRecord(JSON.parse(body));
  const posts = asArray(parsed?.posts);
  const items: FeedItem[] = [];
  for (const entry of posts) {
    const post = asRecord(entry);
    if (!post) continue;
    const author = asRecord(post.author) ?? {};
    const record = asRecord(post.record) ?? {};
    const uri = stringField(post, "uri");
    const handle = stringField(author, "handle");
    const rkey = uri.split("/").filter(Boolean).pop() ?? "";
    const url = handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : "";
    const text = stringField(record, "text");
    const title = text.split("\n").map((line) => line.trim()).find(Boolean) || stringField(author, "displayName") || handle || "post";
    if (!uri && !url) continue;
    items.push(
      feedItem({
        source: "bluesky",
        id: uri || url,
        title,
        url: url || `https://bsky.app/`,
        text,
        author: handle || undefined,
        score: numberField(post, "likeCount"),
        created_at: toIso(stringField(record, "createdAt") || undefined),
      }),
    );
  }
  return capItems(items);
}

export function blueskyRequiresAuth(response: PublicResponse): boolean {
  if (response.status === 401) return true;
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json") && !response.body.trim().startsWith("{")) return false;
  try {
    const parsed = asRecord(JSON.parse(response.body));
    if (!parsed) return false;
    const error = stringField(parsed, "error");
    const message = stringField(parsed, "message");
    if (/auth/i.test(error)) return true;
    if (/authentication required/i.test(message)) return true;
  } catch {
    return false;
  }
  return false;
}

function unavailable(): FeedResult {
  return { unavailable: true, reason: BLUESKY_AUTH_REASON, items: [] };
}

export async function readBluesky(ctx: FeedContext): Promise<FeedResult> {
  const params = new URLSearchParams({ q: ctx.query, limit: "25" });
  const primary = await fetchPublic(`${PRIMARY}?${params}`, ctx);
  if (blueskyRequiresAuth(primary)) return unavailable();
  if (primary.status === 200) return { items: parseBluesky(primary.body) };
  // public.api.bsky.app currently answers searchPosts with a BunnyCDN 403 HTML
  // page from some networks, while api.bsky.app serves the same keyless method.
  // A JSON auth error above returns unavailable and does not fall through.
  if (primary.status === 403 || looksLikeHtml(primary)) {
    const fallback = await fetchPublic(`${FALLBACK}?${params}`, ctx);
    if (blueskyRequiresAuth(fallback)) return unavailable();
    if (fallback.status >= 400) throw new SeeError(`bluesky returned HTTP ${fallback.status}.`, 502);
    return { items: parseBluesky(fallback.body) };
  }
  throw new SeeError(`bluesky returned HTTP ${primary.status}.`, 502);
}

function looksLikeHtml(response: PublicResponse): boolean {
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("text/html")) return true;
  const body = response.body.trimStart().slice(0, 200).toLowerCase();
  return body.startsWith("<!doctype html") || body.startsWith("<html");
}
