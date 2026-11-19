import { fetchPublic, requireOk, type FeedContext } from "./fetch.ts";
import { asArray, asRecord, capItems, feedItem, numberField, optionString, stringField, toIso } from "./text.ts";
import type { FeedItem, FeedResult } from "./types.ts";

export function parseX402Bazaar(body: string): FeedItem[] {
  const parsed = asRecord(JSON.parse(body));
  const resources = asArray(parsed?.resources);
  const items: FeedItem[] = [];
  for (const entry of resources) {
    const record = asRecord(entry);
    if (!record) continue;
    const url = stringField(record, "resource");
    if (!/^https?:\/\//i.test(url)) continue;
    const accepts = asArray(record.accepts);
    const first = asRecord(accepts[0]);
    const payTo = first ? stringField(first, "payTo") : "";
    const quality = asRecord(record.quality);
    const calls = quality ? numberField(quality, "l30DaysTotalCalls") : undefined;
    items.push(
      feedItem({
        source: "x402-bazaar",
        id: url,
        title: stringField(record, "serviceName") || url,
        url,
        text: stringField(record, "description"),
        author: payTo || undefined,
        score: calls,
        created_at: toIso(stringField(record, "lastUpdated") || undefined),
      }),
    );
  }
  return capItems(items);
}

export async function readX402Bazaar(ctx: FeedContext): Promise<FeedResult> {
  const url = new URL("https://api.cdp.coinbase.com/platform/v2/x402/discovery/search");
  url.searchParams.set("query", ctx.query.slice(0, 400));
  url.searchParams.set("limit", "20");
  const network = optionString(ctx.options, "network");
  const asset = optionString(ctx.options, "asset");
  const scheme = optionString(ctx.options, "scheme");
  const maxUsdPrice = optionString(ctx.options, "maxUsdPrice");
  if (network) url.searchParams.set("network", network.slice(0, 200));
  if (asset) url.searchParams.set("asset", asset.slice(0, 200));
  if (scheme) url.searchParams.set("scheme", scheme.slice(0, 200));
  if (maxUsdPrice) url.searchParams.set("maxUsdPrice", maxUsdPrice.slice(0, 200));
  const response = await fetchPublic(url.href, ctx);
  requireOk(response, "x402-bazaar");
  return { items: parseX402Bazaar(response.body) };
}
