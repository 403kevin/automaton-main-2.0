import { SeeError } from "../src/contract.ts";
import { readArchive } from "./archive.ts";
import { readArxiv } from "./arxiv.ts";
import { readBluesky } from "./bluesky.ts";
import { keepPublicItems, type FeedContext } from "./fetch.ts";
import { readHn } from "./hn.ts";
import { readReddit } from "./reddit.ts";
import { readRss } from "./rss.ts";
import { isBlocked, isFeedSource, isUnavailable, type FeedResult, type FeedSource } from "./types.ts";
import { readPageviews } from "./wikimedia-pageviews.ts";
import { readWikipedia } from "./wikipedia.ts";
import { readX402Bazaar } from "./x402-bazaar.ts";

const ADAPTERS: Record<FeedSource, (ctx: FeedContext) => Promise<FeedResult>> = {
  hn: readHn,
  bluesky: readBluesky,
  wikipedia: readWikipedia,
  "wikimedia-pageviews": readPageviews,
  arxiv: readArxiv,
  archive: readArchive,
  rss: readRss,
  "x402-bazaar": readX402Bazaar,
  reddit: readReddit,
};

export async function readFeed(source: string, ctx: FeedContext): Promise<FeedResult> {
  if (!isFeedSource(source)) throw new SeeError("unknown source", 400);
  const result = await ADAPTERS[source](ctx);
  if (isBlocked(result) || isUnavailable(result)) return result;
  return { items: await keepPublicItems(result.items, ctx) };
}

export function knownFeedSource(source: string): source is FeedSource {
  return isFeedSource(source);
}
