import { fetchPublic, requireOk, type FeedContext } from "./fetch.ts";
import { asArray, asRecord, capItems, feedItem, numberField, optionString, stringField, toIso } from "./text.ts";
import type { FeedItem, FeedResult } from "./types.ts";

export function parseWikipedia(body: string, lang = "en"): FeedItem[] {
  const parsed = asRecord(JSON.parse(body));
  const query = asRecord(parsed?.query);
  const rows = asArray(query?.search);
  const items: FeedItem[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const title = stringField(record, "title");
    const id = stringField(record, "pageid");
    if (!title || !id) continue;
    items.push(
      feedItem({
        source: "wikipedia",
        id,
        title,
        url: wikiTitleUrl(lang, title),
        text: stringField(record, "snippet"),
        score: numberField(record, "wordcount"),
        created_at: toIso(stringField(record, "timestamp") || undefined),
      }),
    );
  }
  return capItems(items);
}

export function wikiTitleUrl(lang: string, title: string): string {
  const slug = encodeURIComponent(title.replace(/ /g, "_"));
  return `https://${lang}.wikipedia.org/wiki/${slug}`;
}

export async function readWikipedia(ctx: FeedContext): Promise<FeedResult> {
  const lang = language(optionString(ctx.options, "lang", "language") || "en");
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", ctx.query);
  url.searchParams.set("srlimit", "25");
  url.searchParams.set("utf8", "1");
  url.searchParams.set("format", "json");
  const response = await fetchPublic(url.href, ctx);
  requireOk(response, "wikipedia");
  return { items: parseWikipedia(response.body, lang) };
}

function language(value: string): string {
  return /^[a-z]{2,12}(-[a-z0-9]{2,8})?$/i.test(value) ? value.toLowerCase() : "en";
}
