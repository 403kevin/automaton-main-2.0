import { fetchPublic, requireOk, type FeedContext } from "./fetch.ts";
import { asArray, asRecord, capItems, feedItem, numberField, stringField, toIso } from "./text.ts";
import type { FeedItem, FeedResult } from "./types.ts";

export function parseArchive(body: string): FeedItem[] {
  const parsed = asRecord(JSON.parse(body));
  const response = asRecord(parsed?.response);
  const docs = asArray(response?.docs);
  const items: FeedItem[] = [];
  for (const doc of docs) {
    const record = asRecord(doc);
    if (!record) continue;
    const id = stringField(record, "identifier");
    if (!id) continue;
    const date = stringField(record, "date");
    items.push(
      feedItem({
        source: "archive",
        id,
        title: stringField(record, "title") || id,
        url: `https://archive.org/details/${encodeURIComponent(id)}`,
        text: stringField(record, "description"),
        author: stringField(record, "creator") || undefined,
        score: numberField(record, "downloads"),
        created_at: toIso(date) ?? (date || undefined),
      }),
    );
  }
  return capItems(items);
}

export async function readArchive(ctx: FeedContext): Promise<FeedResult> {
  const url = new URL("https://archive.org/advancedsearch.php");
  url.searchParams.set("q", ctx.query);
  url.searchParams.append("fl[]", "identifier");
  url.searchParams.append("fl[]", "title");
  url.searchParams.append("fl[]", "description");
  url.searchParams.append("fl[]", "creator");
  url.searchParams.append("fl[]", "date");
  url.searchParams.append("fl[]", "downloads");
  url.searchParams.set("output", "json");
  url.searchParams.set("rows", "25");
  const response = await fetchPublic(url.href, ctx);
  requireOk(response, "archive");
  return { items: parseArchive(response.body) };
}
