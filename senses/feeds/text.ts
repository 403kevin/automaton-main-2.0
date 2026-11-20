import { MAX_FEED_ITEMS, type FeedItem } from "./types.ts";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (all, token: string) => {
    if (token.startsWith("#x") || token.startsWith("#X")) {
      const code = Number.parseInt(token.slice(2), 16);
      return Number.isFinite(code) ? safeCodePoint(code) : all;
    }
    if (token.startsWith("#")) {
      const code = Number.parseInt(token.slice(1), 10);
      return Number.isFinite(code) ? safeCodePoint(code) : all;
    }
    return ENTITIES[token] ?? all;
  });
}

function safeCodePoint(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Collapse markup and whitespace. Callers store the trimmed text. */
export function trimText(value: string): string {
  const withoutCdata = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const decoded = decodeEntities(withoutCdata);
  return decoded
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return trimmed;
  return new Date(parsed).toISOString();
}

export function feedItem(input: FeedItem): FeedItem {
  const item: FeedItem = {
    source: input.source,
    id: trimText(input.id).slice(0, 500),
    title: trimText(input.title).slice(0, 500) || "untitled",
    url: input.url.trim(),
    text: trimText(input.text),
  };
  const author = input.author ? trimText(input.author) : "";
  if (author) item.author = author.slice(0, 300);
  if (typeof input.score === "number" && Number.isFinite(input.score)) item.score = input.score;
  if (input.created_at) item.created_at = input.created_at;
  return item;
}

export function capItems(items: FeedItem[]): FeedItem[] {
  return items.filter((item) => item.id && item.url).slice(0, MAX_FEED_ITEMS);
}

export function optionString(options: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = options[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) {
      const parts = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      if (parts.length) return parts.join(", ");
    }
  }
  return "";
}

export function numberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}
