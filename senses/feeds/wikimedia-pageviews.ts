import { fetchPublic, requireOk, type FeedContext } from "./fetch.ts";
import { asArray, asRecord, capItems, feedItem, numberField, optionString, stringField } from "./text.ts";
import { wikiTitleUrl } from "./wikipedia.ts";
import type { FeedItem, FeedResult } from "./types.ts";

export function parsePageviews(body: string, lang = "en"): FeedItem[] {
  const parsed = asRecord(JSON.parse(body));
  const rows = asArray(parsed?.items);
  const items: FeedItem[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const article = stringField(record, "article").replace(/_/g, " ");
    const stamp = stringField(record, "timestamp");
    const views = numberField(record, "views");
    if (!article || !stamp) continue;
    items.push(
      feedItem({
        source: "wikimedia-pageviews",
        id: `${article}:${stamp}`,
        title: article,
        url: wikiTitleUrl(lang, article),
        text: views === undefined ? stamp : `${views} views`,
        score: views,
        created_at: pageviewStamp(stamp),
      }),
    );
  }
  return capItems(items.slice(-25));
}

export function pageviewStamp(stamp: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})?$/.exec(stamp);
  if (!match) return undefined;
  const hour = match[4] ?? "00";
  return `${match[1]}-${match[2]}-${match[3]}T${hour}:00:00.000Z`;
}

export async function readPageviews(ctx: FeedContext): Promise<FeedResult> {
  const lang = language(optionString(ctx.options, "lang", "language") || "en");
  const project = projectName(optionString(ctx.options, "project") || `${lang}.wikipedia`);
  const access = enumOption(optionString(ctx.options, "access"), ["all-access", "desktop", "mobile-app", "mobile-web"], "all-access");
  const agent = enumOption(optionString(ctx.options, "agent"), ["all-agents", "user", "spider", "automated"], "all-agents");
  const end = dateOption(optionString(ctx.options, "end")) ?? ymd(ctx.now());
  const start = dateOption(optionString(ctx.options, "start")) ?? ymd(ctx.now() - 30 * 86_400_000);
  const article = encodeURIComponent(ctx.query.replace(/ /g, "_"));
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${project}/${access}/${agent}/${article}/daily/${start}/${end}`;
  const response = await fetchPublic(url, ctx);
  requireOk(response, "wikimedia-pageviews");
  return { items: parsePageviews(response.body, lang) };
}

function language(value: string): string {
  return /^[a-z]{2,12}$/i.test(value) ? value.toLowerCase() : "en";
}

function projectName(value: string): string {
  return /^[a-z0-9.-]{2,40}$/i.test(value) ? value.toLowerCase() : "en.wikipedia";
}

function enumOption(value: string, allowed: string[], fallback: string): string {
  return allowed.includes(value) ? value : fallback;
}

function dateOption(value: string): string | null {
  return /^\d{8}$/.test(value) ? value : null;
}

function ymd(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}${month}${day}`;
}
