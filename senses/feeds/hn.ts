import { fetchPublic, requireOk, type FeedContext } from "./fetch.ts";
import { asArray, asRecord, capItems, feedItem, numberField, stringField, toIso } from "./text.ts";
import type { FeedItem, FeedResult } from "./types.ts";

export function parseHn(body: string): FeedItem[] {
  const parsed = asRecord(JSON.parse(body));
  const hits = asArray(parsed?.hits);
  const items: FeedItem[] = [];
  for (const hit of hits) {
    const record = asRecord(hit);
    if (!record) continue;
    const id = stringField(record, "objectID");
    if (!id) continue;
    const title = stringField(record, "title", "story_title") || "Comment";
    const ownUrl = stringField(record, "url");
    const url = /^https?:\/\//i.test(ownUrl) ? ownUrl : `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}`;
    const text = stringField(record, "story_text", "comment_text");
    items.push(
      feedItem({
        source: "hn",
        id,
        title,
        url,
        text,
        author: stringField(record, "author") || undefined,
        score: numberField(record, "points"),
        created_at: toIso(stringField(record, "created_at") || undefined),
      }),
    );
  }
  return capItems(items);
}

export async function readHn(ctx: FeedContext): Promise<FeedResult> {
  const url = new URL("https://hn.algolia.com/api/v1/search");
  url.searchParams.set("query", ctx.query);
  url.searchParams.set("hitsPerPage", "25");
  const tags = typeof ctx.options.tags === "string" ? ctx.options.tags.trim() : "";
  if (tags) url.searchParams.set("tags", tags);
  const response = await fetchPublic(url.href, ctx);
  requireOk(response, "hn");
  return { items: parseHn(response.body) };
}
