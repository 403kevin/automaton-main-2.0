import { type BrowseRequest, type PageView, SeeError } from "./contract.ts";
import { htmlToMarkdown } from "./markdown.ts";
import {
  MAX_BODY_BYTES,
  PAGE_TIMEOUT_MS,
  reviewHop,
  reviewSeeUrl,
  type FetchHop,
  type ResolveHost,
} from "./safety.ts";

/**
 * Polite crawl of one public site.
 *
 * Visible text is the HTML with the head, scripts, styles, svg, and tags removed.
 * Fewer than THIN_TEXT_CHARS (80) characters is treated as a script shell
 * and rendered with the existing Playwright browse. A page with 80 or more
 * characters stays on the plain GET.
 *
 * Requests to one host are at least MIN_HOST_DELAY_MS (1000) apart. A
 * robots.txt Crawl-delay larger than that is used, and never above
 * MAX_CRAWL_DELAY_MS (10 seconds).
 */
export const CRAWLER_UA = "AutomatonSenses/2.0";
export const MIN_HOST_DELAY_MS = 1_000;
export const MAX_CRAWL_DELAY_MS = 10_000;
export const CRAWL_BUDGET_MS = 120_000;
export const MAX_CRAWL_PAGES = 20;
export const DEFAULT_CRAWL_PAGES = 10;
export const THIN_TEXT_CHARS = 80;

const MAX_PAGE_MARKDOWN = 60_000;
const MAX_LINKS_PER_PAGE = 100;
const MAX_SITEMAP_DOCS = 5;
const MAX_SITEMAP_LOCS = 100;

const FILE_EXTENSIONS = new Set([
  "pdf", "zip", "gz", "tgz", "tar", "rar", "7z",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif",
  "mp3", "mp4", "wav", "avi", "mov", "webm", "ogg",
  "css", "js", "mjs", "cjs", "map",
  "woff", "woff2", "ttf", "eot", "otf",
  "json", "csv", "txt", "xml",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "apk", "dmg", "exe", "bin", "iso",
]);

export type RobotsStatus = "ok" | "missing" | "unreachable";

export interface CrawlPage {
  url: string;
  title: string;
  markdown: string;
}

export interface CrawlSkip {
  url: string;
  reason: string;
}

export interface CrawlResult {
  pages: CrawlPage[];
  skipped: CrawlSkip[];
  robots: RobotsStatus;
}

export interface LoadedDocument {
  status: number;
  location: string | null;
  contentType: string;
  body: Buffer;
  tooBig: boolean;
  error?: string;
}

export interface LoadInit {
  userAgent: string;
  accept: string;
  /** When set, a non-HTML content type is not downloaded. */
  htmlOnly: boolean;
}

export type LoadDocument = (url: string, init: LoadInit) => Promise<LoadedDocument>;

export interface CrawlInput {
  url: string;
  maxPages: number;
  sameDomain: boolean;
  denyHosts: readonly string[];
  resolveHost: ResolveHost;
  load: LoadDocument;
  browse: (input: BrowseRequest) => Promise<PageView>;
  minDelayMs?: number;
  budgetMs?: number;
  executablePath?: string;
  launchArgs?: string[];
}

interface RobotsRule {
  allow: boolean;
  path: string;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelay?: number;
}

interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export function hostDelayMs(crawlDelaySeconds: number | undefined, floorMs: number): number {
  const requested =
    crawlDelaySeconds === undefined || !Number.isFinite(crawlDelaySeconds) ? 0 : Math.round(crawlDelaySeconds * 1000);
  const floor = Number.isFinite(floorMs) ? Math.max(0, floorMs) : MIN_HOST_DELAY_MS;
  return Math.min(MAX_CRAWL_DELAY_MS, Math.max(floor, requested));
}

/** Longest Allow/Disallow wins. The product token beats `*`. An empty rule set allows the path. */
export function allowedByRobots(robotsText: string, resourcePath: string): boolean {
  const selected = selectGroups(parseRobots(robotsText));
  return pathAllowed(selected.flatMap((group) => group.rules), resourcePath);
}

export function crawlDelaySeconds(robotsText: string): number | undefined {
  const selected = selectGroups(parseRobots(robotsText));
  let delay: number | undefined;
  for (const group of selected) {
    if (group.crawlDelay === undefined) continue;
    delay = delay === undefined ? group.crawlDelay : Math.max(delay, group.crawlDelay);
  }
  return delay;
}

export async function defaultLoadDocument(url: string, init: LoadInit): Promise<LoadedDocument> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": init.userAgent,
        accept: init.accept,
      },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "fetch failed";
    return {
      status: 0,
      location: null,
      contentType: "",
      body: Buffer.alloc(0),
      tooBig: false,
      error: /timeout|aborted/i.test(message) ? "timeout" : message,
    };
  }
  const contentType = response.headers.get("content-type") ?? "";
  const location = response.headers.get("location");
  const advertised = Number(response.headers.get("content-length") ?? "0");
  const redirect = response.status >= 300 && response.status < 400;
  if (Number.isFinite(advertised) && advertised > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, location, contentType, body: Buffer.alloc(0), tooBig: true };
  }
  if (!redirect && init.htmlOnly && contentType && !isHtmlType(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, location, contentType, body: Buffer.alloc(0), tooBig: false };
  }
  try {
    const read = await readLimited(response);
    if (read.tooBig) {
      return { status: response.status, location, contentType, body: Buffer.alloc(0), tooBig: true };
    }
    return { status: response.status, location, contentType, body: read.body, tooBig: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "fetch failed";
    return {
      status: response.status,
      location,
      contentType,
      body: Buffer.alloc(0),
      tooBig: false,
      error: /timeout|aborted/i.test(message) ? "timeout" : message,
    };
  }
}

export async function crawlSite(input: CrawlInput): Promise<CrawlResult> {
  const start = canonical(input.url);
  if (!start) throw new SeeError("URL is not valid.", 400);
  const opened = await reviewHop(start.href, input.denyHosts, input.resolveHost);
  if (!opened.allowed) throw new SeeError(opened.reason, 400);

  const floor = input.minDelayMs ?? MIN_HOST_DELAY_MS;
  const budgetMs = input.budgetMs ?? CRAWL_BUDGET_MS;
  const started = Date.now();
  const expired = () => Date.now() - started >= budgetMs;
  const pacer = new Pacer(hostDelayMs(undefined, floor));
  const originHost = hostOf(start);
  const sameDomain = input.sameDomain;
  const skipped: CrawlSkip[] = [];
  const skippedUrls = new Set<string>();
  const queued = new Set<string>();
  const queue: string[] = [];
  const pages: CrawlPage[] = [];

  const noteSkip = (url: string, reason: string) => {
    if (skippedUrls.has(url)) return;
    skippedUrls.add(url);
    skipped.push({ url, reason });
  };

  const loadKind = (htmlOnly: boolean): LoadInit => ({
    userAgent: CRAWLER_UA,
    accept: htmlOnly ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" : "*/*",
    htmlOnly,
  });

  const attempt = async (url: string, htmlOnly: boolean): Promise<Attempt> => {
    const cache = new Map<string, LoadedDocument>();
    let finalUrl = url;
    let offHost = false;
    const fetchHop: FetchHop = async (target) => {
      finalUrl = target;
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        return { status: 400, location: null };
      }
      if (sameDomain && hostOf(parsed) !== originHost) {
        offHost = true;
        cache.set(target, emptyDoc("other host"));
        return { status: 200, location: null };
      }
      if (expired()) {
        cache.set(target, emptyDoc("time budget"));
        return { status: 200, location: null };
      }
      await pacer.wait(hostOf(parsed));
      if (expired()) {
        cache.set(target, emptyDoc("time budget"));
        return { status: 200, location: null };
      }
      const doc = await input.load(target, loadKind(htmlOnly));
      pacer.done(hostOf(parsed));
      cache.set(target, doc);
      if (doc.error) return { status: doc.location ? doc.status || 302 : 0, location: doc.location, tooBig: false };
      const status = doc.status === 0 && doc.location ? 302 : doc.status;
      return { status, location: doc.location, tooBig: doc.tooBig };
    };
    const verdict = await reviewSeeUrl(url, input.denyHosts, input.resolveHost, fetchHop);
    return { verdict, finalUrl, doc: cache.get(finalUrl) ?? null, offHost };
  };

  const robotsUrl = new URL("/robots.txt", start.origin).href;
  const robotsAttempt = await attempt(robotsUrl, false);
  const robots = classifyRobots(robotsAttempt);
  let rules: RobotsRule[] = [];
  let sitemapUrls: string[] = [];
  if (robots === "ok" && robotsAttempt.doc) {
    const text = robotsAttempt.doc.body.toString("utf8");
    const parsed = parseRobots(text);
    rules = selectGroups(parsed).flatMap((group) => group.rules);
    pacer.setDelay(hostDelayMs(crawlDelaySeconds(text), floor));
    sitemapUrls = parsed.sitemaps.map((item) => resolveHttp(item, robotsUrl)).filter((item): item is string => item !== null);
  }
  if (robots === "unreachable") {
    noteSkip(start.href, "robots");
    return { pages, skipped, robots };
  }
  if (sitemapUrls.length === 0) sitemapUrls = [new URL("/sitemap.xml", start.origin).href];

  const disallowed = (url: URL) => !pathAllowed(rules, `${url.pathname}${url.search}`);

  const consider = async (raw: string, fromPage: boolean) => {
    const url = canonical(raw);
    if (!url) return;
    const href = url.href;
    if (queued.has(href) || skippedUrls.has(href)) return;
    const verdict = await reviewHop(href, input.denyHosts, input.resolveHost);
    if (!verdict.allowed) {
      noteSkip(href, verdict.reason);
      queued.add(href);
      return;
    }
    if (isFilePath(url.pathname)) {
      if (fromPage) noteSkip(href, "file");
      queued.add(href);
      return;
    }
    if (sameDomain && hostOf(url) !== originHost) {
      if (fromPage) noteSkip(href, "other host");
      queued.add(href);
      return;
    }
    if (disallowed(url)) {
      noteSkip(href, "robots");
      queued.add(href);
      return;
    }
    if (pages.length + queue.length >= input.maxPages) return;
    queued.add(href);
    queue.push(href);
  };

  if (disallowed(start)) noteSkip(start.href, "robots");
  else {
    queued.add(start.href);
    queue.push(start.href);
  }

  const seenSitemaps = new Set<string>();
  const absorbSitemap = async (url: string, depth: number) => {
    if (depth > 2 || seenSitemaps.size >= MAX_SITEMAP_DOCS || expired()) return;
    const mapUrl = canonical(url);
    if (!mapUrl || seenSitemaps.has(mapUrl.href)) return;
    if (sameDomain && hostOf(mapUrl) !== originHost) return;
    const mapVerdict = await reviewHop(mapUrl.href, input.denyHosts, input.resolveHost);
    if (!mapVerdict.allowed) return;
    seenSitemaps.add(mapUrl.href);
    const got = await attempt(mapUrl.href, false);
    if (!got.verdict.allowed || got.offHost || !got.doc || got.doc.error || got.doc.tooBig) return;
    if (got.doc.status < 200 || got.doc.status >= 300) return;
    const xml = got.doc.body.toString("utf8");
    const parsed = parseSitemap(xml);
    if (parsed.indexes.length > 0) {
      for (const child of parsed.indexes) {
        if (seenSitemaps.size >= MAX_SITEMAP_DOCS) break;
        const next = canonical(child, got.finalUrl);
        if (next) await absorbSitemap(next.href, depth + 1);
      }
      return;
    }
    for (const loc of parsed.locs) {
      const next = canonical(loc, got.finalUrl);
      if (next) await consider(next.href, false);
    }
  };
  for (const sitemap of sitemapUrls) {
    if (pages.length + queue.length >= input.maxPages) break;
    await absorbSitemap(sitemap, 0);
  }

  while (queue.length > 0 && pages.length < input.maxPages) {
    if (expired()) break;
    const href = queue.shift()!;
    const got = await attempt(href, true);
    if (got.doc?.error === "time budget") break;
    if (!got.verdict.allowed) {
      if (/2 MB/.test(got.verdict.reason)) {
        noteSkip(href, "too big");
        continue;
      }
      if (href === start.href) throw new SeeError(got.verdict.reason, 400);
      noteSkip(href, got.verdict.reason);
      continue;
    }
    if (got.offHost || got.doc?.error === "other host") {
      noteSkip(href, "other host");
      continue;
    }
    if (!got.doc || got.doc.error) {
      noteSkip(href, got.doc?.error ?? "fetch failed");
      continue;
    }
    if (got.doc.tooBig) {
      noteSkip(href, "too big");
      continue;
    }
    if (got.doc.status < 200 || got.doc.status >= 300) {
      noteSkip(href, `http ${got.doc.status}`);
      continue;
    }
    if (!isHtmlDocument(got.doc)) {
      noteSkip(href, "not html");
      continue;
    }
    const html = got.doc.body.toString("utf8");
    let title = "";
    let markdown = "";
    let links: string[] = [];
    if (visibleText(html).length < THIN_TEXT_CHARS) {
      if (expired()) break;
      let renderHost = originHost;
      try {
        renderHost = hostOf(new URL(got.finalUrl));
        await pacer.wait(renderHost);
      } catch {
        noteSkip(href, "fetch failed");
        continue;
      }
      if (expired()) break;
      try {
        const view = await input.browse({
          url: got.finalUrl,
          screenshot: false,
          denyHosts: input.denyHosts,
          resolveHost: input.resolveHost,
          executablePath: input.executablePath,
          launchArgs: input.launchArgs,
        });
        title = view.title;
        markdown = view.markdown;
        links = view.links;
      } catch (error) {
        noteSkip(href, error instanceof Error ? error.message : "render failed");
        continue;
      } finally {
        pacer.done(renderHost);
      }
    } else {
      title = htmlTitle(html);
      try {
        markdown = htmlToMarkdown(mainHtml(html));
      } catch {
        markdown = visibleText(html);
      }
      links = extractLinks(html, got.finalUrl);
    }
    queued.add(got.finalUrl);
    pages.push({
      url: got.finalUrl,
      title: title.trim().slice(0, 300),
      markdown: markdown.slice(0, MAX_PAGE_MARKDOWN),
    });
    for (const link of links.slice(0, MAX_LINKS_PER_PAGE)) await consider(link, true);
  }

  return { pages, skipped, robots };
}

interface Attempt {
  verdict: { allowed: boolean; reason: string };
  finalUrl: string;
  doc: LoadedDocument | null;
  offHost: boolean;
}

function classifyRobots(attempt: Attempt): RobotsStatus {
  if (!attempt.verdict.allowed || attempt.offHost) return "unreachable";
  const doc = attempt.doc;
  if (!doc || doc.error || doc.tooBig || doc.status === 0 || doc.status >= 500) return "unreachable";
  if (doc.status >= 400 && doc.status < 500) return "missing";
  if (doc.status >= 200 && doc.status < 300) return "ok";
  return "unreachable";
}

function emptyDoc(error: string): LoadedDocument {
  return { status: 0, location: null, contentType: "", body: Buffer.alloc(0), tooBig: false, error };
}

class Pacer {
  private readonly last = new Map<string, number>();

  constructor(private delayMs: number) {}

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  async wait(host: string): Promise<void> {
    const prev = this.last.get(host.toLowerCase());
    if (prev === undefined || this.delayMs <= 0) return;
    const target = prev + this.delayMs;
    while (Date.now() < target) {
      const remaining = target - Date.now();
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(remaining, 50))));
    }
  }

  /** Stamp after the response arrives, so the next request waits a full gap. */
  done(host: string): void {
    this.last.set(host.toLowerCase(), Date.now());
  }
}

function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let startedRules = false;
  const body = text.replace(/^\uFEFF/, "");
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const split = line.indexOf(":");
    if (split < 0) continue;
    const field = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
    if (field === "user-agent") {
      if (!current || startedRules) {
        current = { agents: [], rules: [] };
        groups.push(current);
        startedRules = false;
      }
      if (value) current.agents.push(value);
      continue;
    }
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      startedRules = true;
      if (value) current.rules.push({ allow: field === "allow", path: value });
      continue;
    }
    if (field === "crawl-delay") {
      startedRules = true;
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) current.crawlDelay = parsed;
    }
  }
  return { groups, sitemaps };
}

function selectGroups(parsed: ParsedRobots): RobotsGroup[] {
  const ua = CRAWLER_UA.toLowerCase();
  const specific = parsed.groups.filter((group) =>
    group.agents.some((agent) => {
      const token = agent.trim().toLowerCase();
      return token !== "*" && token.length > 0 && ua.includes(token);
    }),
  );
  if (specific.length > 0) return specific;
  return parsed.groups.filter((group) => group.agents.some((agent) => agent.trim() === "*"));
}

function pathAllowed(rules: readonly RobotsRule[], resourcePath: string): boolean {
  let best: { length: number; allow: boolean } | null = null;
  for (const rule of rules) {
    if (!pathMatches(rule.path, resourcePath)) continue;
    const length = rule.path.length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) {
      best = { length, allow: rule.allow };
    }
  }
  return best ? best.allow : true;
}

function pathMatches(pattern: string, resourcePath: string): boolean {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      source += ".*";
      continue;
    }
    if (char === "$" && index === pattern.length - 1) {
      source += "$";
      continue;
    }
    source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  if (!pattern.endsWith("$")) source += ".*";
  return new RegExp(source).test(resourcePath);
}

function parseSitemap(xml: string): { locs: string[]; indexes: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => decodeXml(match[1] ?? ""));
  if (/<sitemapindex[\s>]/i.test(xml)) return { locs: [], indexes: locs.slice(0, MAX_SITEMAP_LOCS) };
  return { locs: locs.slice(0, MAX_SITEMAP_LOCS), indexes: [] };
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function decodeHtml(value: string): string {
  return decodeXml(value)
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    })
    .replace(/&#(\d+);/g, (whole, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

export function visibleText(html: string): string {
  return html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function mainHtml(html: string): string {
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html);
  const source = main?.[2] ?? (/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html);
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "");
}

function htmlTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? decodeHtml(match[1]) : "";
}

function extractLinks(html: string, base: string): string[] {
  const baseTag = /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(html);
  const baseHref = (baseTag?.[1] ?? baseTag?.[2] ?? "").trim();
  let resolvedBase = base;
  if (baseHref) {
    try {
      resolvedBase = new URL(baseHref, base).href;
    } catch {
      resolvedBase = base;
    }
  }
  const links: string[] = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  for (const match of html.matchAll(pattern)) {
    const href = decodeHtml(match[1] ?? match[2] ?? match[3] ?? "");
    if (!href || href.startsWith("#")) continue;
    if (/^(javascript|mailto|data|tel|blob):/i.test(href)) continue;
    const url = canonical(href, resolvedBase);
    if (url) links.push(url.href);
  }
  return [...new Set(links)];
}

function isHtmlType(contentType: string): boolean {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime === "text/html" || mime === "application/xhtml+xml";
}

function isHtmlDocument(doc: LoadedDocument): boolean {
  if (isHtmlType(doc.contentType)) return true;
  if (doc.contentType.split(";")[0]?.trim()) return false;
  const head = doc.body.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head") || head.startsWith("<body");
}

function isFilePath(pathname: string): boolean {
  const base = pathname.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return FILE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

function canonical(raw: string, base?: string): URL | null {
  try {
    const url = base ? new URL(raw, base) : new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function resolveHttp(raw: string, base: string): string | null {
  return canonical(raw, base)?.href ?? null;
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

async function readLimited(response: Response): Promise<{ body: Buffer; tooBig: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { body: Buffer.alloc(0), tooBig: false };
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { body: Buffer.alloc(0), tooBig: true };
    }
    chunks.push(Buffer.from(value));
  }
  return { body: Buffer.concat(chunks), tooBig: false };
}
