import { SeeError } from "../src/contract.ts";
import { fetchPublic, requireOk, type FeedContext } from "./fetch.ts";
import { parseFeedXml } from "./xml.ts";
import type { FeedItem, FeedResult } from "./types.ts";

export function parseRss(body: string): FeedItem[] {
  return parseFeedXml(body, "rss");
}

export async function readRss(ctx: FeedContext): Promise<FeedResult> {
  let url: URL;
  try {
    url = new URL(ctx.query);
  } catch {
    throw new SeeError("RSS query must be an http(s) URL.", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SeeError("RSS query must be an http(s) URL.", 400);
  }
  const response = await fetchPublic(url.href, ctx);
  requireOk(response, "rss");
  return { items: parseRss(response.body) };
}
