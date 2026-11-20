/** Normalized earful. Every adapter returns this shape. */
export interface FeedItem {
  source: string;
  id: string;
  title: string;
  url: string;
  text: string;
  author?: string;
  score?: number;
  created_at?: string;
}

export interface FeedItems {
  items: FeedItem[];
}

/** Reddit (or a block page) answered, but not with a feed. */
export interface FeedBlocked {
  blocked: true;
  status: number;
  reason: string;
  items: [];
}

/** The upstream exists and refused to speak without credentials. */
export interface FeedUnavailable {
  unavailable: true;
  reason: string;
  items: [];
}

export type FeedResult = FeedItems | FeedBlocked | FeedUnavailable;

export const FEED_SOURCES = [
  "hn",
  "bluesky",
  "wikipedia",
  "wikimedia-pageviews",
  "arxiv",
  "archive",
  "rss",
  "x402-bazaar",
  "reddit",
] as const;

export type FeedSource = (typeof FEED_SOURCES)[number];

export const MAX_FEED_ITEMS = 25;
export const FEED_TIMEOUT_MS = 15_000;

export const DEFAULT_REDDIT_USER_AGENT = "AutomatonSenses/2.0 (key-free public JSON reader; no OAuth)";

export function isFeedSource(source: string): source is FeedSource {
  return (FEED_SOURCES as readonly string[]).includes(source);
}

export function isBlocked(result: FeedResult): result is FeedBlocked {
  return "blocked" in result && result.blocked === true;
}

export function isUnavailable(result: FeedResult): result is FeedUnavailable {
  return "unavailable" in result && result.unavailable === true;
}
