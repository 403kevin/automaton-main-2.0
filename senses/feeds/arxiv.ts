import { fetchPublic, requireOk, type FeedContext } from "./fetch.ts";
import { parseFeedXml } from "./xml.ts";
import type { FeedItem, FeedResult } from "./types.ts";

export function parseArxiv(body: string): FeedItem[] {
  return parseFeedXml(body, "arxiv");
}

export async function readArxiv(ctx: FeedContext): Promise<FeedResult> {
  const search = ctx.query.includes(":") ? ctx.query : `all:${ctx.query}`;
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", search);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", "25");
  const response = await fetchPublic(url.href, ctx);
  requireOk(response, "arxiv");
  return { items: parseArxiv(response.body) };
}
