import http from "node:http";
import { pathToFileURL } from "node:url";
import { readFeed, knownFeedSource } from "../feeds/index.ts";
import type { FeedContext } from "../feeds/fetch.ts";
import { DEFAULT_REDDIT_USER_AGENT } from "../feeds/types.ts";
import { runBrowseScript, type BrowseJob } from "./browse-run.ts";
import { crawlSite, defaultLoadDocument, MAX_CRAWL_PAGES, type LoadDocument } from "./crawl.ts";
import { type BrowseRequest, type PageView, SeeError } from "./contract.ts";
import { SerialQueue } from "./queue.ts";
import {
  defaultFetchHop,
  defaultResolve,
  MAX_BODY_BYTES,
  reviewSeeUrl,
  type FetchHop,
  type ResolveHost,
} from "./safety.ts";

const REQUEST_LIMIT = 64 * 1024;

export interface SensesServerOptions {
  browse?: (input: BrowseRequest) => Promise<PageView>;
  resolveHost?: ResolveHost;
  fetchHop?: FetchHop;
  loadDocument?: LoadDocument;
  minHostDelayMs?: number;
  crawlBudgetMs?: number;
  executablePath?: string;
  launchArgs?: string[];
  feedFetch?: typeof fetch;
  feedNow?: () => number;
  feedSleep?: (ms: number) => Promise<void>;
  redditUserAgent?: string;
  runBrowse?: (input: BrowseJob) => Promise<Record<string, unknown>>;
}

interface JobResult {
  status: number;
  body: unknown;
}

export function createSensesServer(options: SensesServerOptions = {}): http.Server {
  const queue = new SerialQueue();
  const resolveHost = options.resolveHost ?? defaultResolve;
  const fetchHop = options.fetchHop ?? defaultFetchHop;
  const loadDocument = options.loadDocument ?? defaultLoadDocument;
  const see =
    options.browse ??
    (async (input: BrowseRequest) => {
      const mod = await import("./browse.ts");
      return mod.browse({
        ...input,
        executablePath: options.executablePath,
        launchArgs: options.launchArgs,
      });
    });

  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/health" || req.url === "/health/")) {
        send(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && (req.url === "/see" || req.url === "/see/")) {
        const result = await queue.run(() => handleSee(req, see, resolveHost, fetchHop));
        send(res, result.status, result.body);
        return;
      }
      if (req.method === "POST" && (req.url === "/crawl" || req.url === "/crawl/")) {
        const result = await queue.run(() => handleCrawl(req, see, resolveHost, loadDocument, options));
        send(res, result.status, result.body);
        return;
      }
      if (req.method === "POST" && (req.url === "/feed" || req.url === "/feed/")) {
        const result = await queue.run(() => handleFeed(req, resolveHost, options));
        send(res, result.status, result.body);
        return;
      }
      if (req.method === "POST" && (req.url === "/browse" || req.url === "/browse/")) {
        const result = await queue.run(() => handleBrowse(req, options.runBrowse ?? runBrowseScript));
        send(res, result.status, result.body);
        return;
      }
      send(res, 404, { error: "Not found." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "see failed";
      const status = error instanceof SeeError ? error.status : 500;
      if (!res.headersSent) send(res, status, { error: message });
    }
  });
}

const BROWSE_HARD_STEPS = 15;

async function handleBrowse(
  req: http.IncomingMessage,
  run: (input: BrowseJob) => Promise<Record<string, unknown>>,
): Promise<JobResult> {
  const parsed = await readJson(req);
  if (!parsed.ok) return parsed.result;
  const record = parsed.record;
  const task = typeof record.task === "string" ? record.task.trim() : "";
  if (!task) return { status: 400, body: { error: "task is required." } };
  if (task.length > 4_000) return { status: 400, body: { error: "task is too long." } };
  const maxSteps = readBrowseSteps(record.max_steps);
  if (!maxSteps.ok) return { status: 400, body: { error: maxSteps.error } };
  const denyHosts = Array.isArray(record.denyHosts)
    ? record.denyHosts.filter((item): item is string => typeof item === "string")
    : [];
  const job: BrowseJob = {
    task,
    maxSteps: maxSteps.value,
    denyHosts,
    llmBaseUrl: typeof record.llm_base_url === "string" ? record.llm_base_url : "",
    llmToken: typeof record.llm_token === "string" ? record.llm_token : "",
    model: typeof record.model === "string" ? record.model : "",
  };
  try {
    const result = await run(job);
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof SeeError) return { status: error.status, body: { error: error.message } };
    const message = error instanceof Error ? error.message : "browse failed";
    return { status: 502, body: { error: message } };
  }
}

function readBrowseSteps(value: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: BROWSE_HARD_STEPS };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return { ok: false, error: `max_steps must be an integer from 1 to ${BROWSE_HARD_STEPS}.` };
  }
  return { ok: true, value: Math.min(value, BROWSE_HARD_STEPS) };
}

async function handleFeed(
  req: http.IncomingMessage,
  resolveHost: ResolveHost,
  options: SensesServerOptions,
): Promise<JobResult> {
  const parsed = await readJson(req);
  if (!parsed.ok) return parsed.result;
  const record = parsed.record;
  const source = typeof record.source === "string" ? record.source.trim().toLowerCase() : "";
  if (!knownFeedSource(source)) return { status: 400, body: { error: "unknown source" } };
  if (typeof record.query !== "string" || !record.query.trim()) {
    return { status: 400, body: { error: "query is required." } };
  }
  if (record.query.length > 2_000) return { status: 400, body: { error: "query is too long." } };
  if (record.options !== undefined && (!record.options || typeof record.options !== "object" || Array.isArray(record.options))) {
    return { status: 400, body: { error: "options must be an object." } };
  }
  const denyHosts = Array.isArray(record.denyHosts)
    ? record.denyHosts.filter((item): item is string => typeof item === "string")
    : [];
  const ctx: FeedContext = {
    query: record.query.trim(),
    options: (record.options as Record<string, unknown> | undefined) ?? {},
    denyHosts,
    resolveHost,
    fetchImpl: options.feedFetch ?? fetch,
    now: options.feedNow ?? Date.now,
    sleep:
      options.feedSleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    userAgent: feedUserAgent(record, options),
  };
  try {
    const result = await readFeed(source, ctx);
    return { status: 200, body: { source, ...result } };
  } catch (error) {
    if (error instanceof SeeError) return { status: error.status, body: { error: error.message } };
    const message = error instanceof Error ? error.message : "feed failed";
    return { status: 502, body: { error: message } };
  }
}

function feedUserAgent(record: Record<string, unknown>, options: SensesServerOptions): string {
  const fromBody = typeof record.userAgent === "string" ? record.userAgent.replace(/[\r\n]/g, "").trim() : "";
  if (fromBody && fromBody.length <= 200) return fromBody;
  const configured = (options.redditUserAgent ?? process.env.REDDIT_USER_AGENT ?? "").replace(/[\r\n]/g, "").trim();
  return configured || DEFAULT_REDDIT_USER_AGENT;
}

async function handleCrawl(
  req: http.IncomingMessage,
  browse: (input: BrowseRequest) => Promise<PageView>,
  resolveHost: ResolveHost,
  loadDocument: LoadDocument,
  options: SensesServerOptions,
): Promise<JobResult> {
  const parsed = await readJson(req);
  if (!parsed.ok) return parsed.result;
  const record = parsed.record;
  if (typeof record.url !== "string" || !record.url.trim()) {
    return { status: 400, body: { error: "url is required." } };
  }
  const maxPages = readMaxPages(record.max_pages);
  if (!maxPages.ok) return { status: 400, body: { error: maxPages.error } };
  const sameDomain = readSameDomain(record.same_domain);
  if (!sameDomain.ok) return { status: 400, body: { error: sameDomain.error } };
  const denyHosts = Array.isArray(record.denyHosts)
    ? record.denyHosts.filter((item): item is string => typeof item === "string")
    : [];
  try {
    const crawl = await crawlSite({
      url: record.url,
      maxPages: maxPages.value,
      sameDomain: sameDomain.value,
      denyHosts,
      resolveHost,
      load: loadDocument,
      browse,
      minDelayMs: options.minHostDelayMs,
      budgetMs: options.crawlBudgetMs,
      executablePath: options.executablePath,
      launchArgs: options.launchArgs,
    });
    return { status: 200, body: crawl };
  } catch (error) {
    if (error instanceof SeeError) return { status: error.status, body: { error: error.message } };
    const message = error instanceof Error ? error.message : "crawl failed";
    return { status: 502, body: { error: message } };
  }
}

function readMaxPages(value: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: 10 };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CRAWL_PAGES) {
    return { ok: false, error: `max_pages must be an integer from 1 to ${MAX_CRAWL_PAGES}.` };
  }
  return { ok: true, value };
}

function readSameDomain(value: unknown): { ok: true; value: boolean } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: true };
  if (typeof value !== "boolean") return { ok: false, error: "same_domain must be a boolean." };
  return { ok: true, value };
}

async function readJson(
  req: http.IncomingMessage,
): Promise<{ ok: true; record: Record<string, unknown> } | { ok: false; result: JobResult }> {
  let raw: string;
  try {
    raw = await readBody(req, REQUEST_LIMIT);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the request.";
    return { ok: false, result: { status: 400, body: { error: message } } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, result: { status: 400, body: { error: "Request body is not JSON." } } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, result: { status: 400, body: { error: "Request body must be an object." } } };
  }
  return { ok: true, record: parsed as Record<string, unknown> };
}

async function handleSee(
  req: http.IncomingMessage,
  see: (input: BrowseRequest) => Promise<PageView>,
  resolveHost: ResolveHost,
  fetchHop: FetchHop,
): Promise<JobResult> {
  let raw: string;
  try {
    raw = await readBody(req, REQUEST_LIMIT);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the request.";
    return { status: 400, body: { error: message } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "Request body is not JSON." } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: 400, body: { error: "Request body must be an object." } };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.url !== "string" || !record.url.trim()) {
    return { status: 400, body: { error: "url is required." } };
  }
  const screenshot = record.screenshot === true;
  const denyHosts = Array.isArray(record.denyHosts)
    ? record.denyHosts.filter((item): item is string => typeof item === "string")
    : [];
  const reviewed = await reviewSeeUrl(record.url, denyHosts, resolveHost, fetchHop);
  if (!reviewed.allowed) return { status: 400, body: { error: reviewed.reason } };
  try {
    const page = await see({ url: record.url, screenshot, denyHosts, resolveHost });
    const body: PageView = {
      title: page.title,
      markdown: page.markdown,
      links: page.links,
    };
    if (screenshot && page.png) body.png = page.png;
    return { status: 200, body };
  } catch (error) {
    if (error instanceof SeeError) return { status: error.status, body: { error: error.message } };
    const message = error instanceof Error ? error.message : "see failed";
    return { status: 502, body: { error: message } };
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new SeeError("Request body is too large.", 400));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  let payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > MAX_BODY_BYTES) {
    payload = JSON.stringify({ error: "Response body exceeds 2 MB." });
    status = 413;
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry && import.meta.url === entry) {
  const port = Number(process.env.PORT ?? "7070");
  const server = createSensesServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ msg: "senses listening", port }));
  });
}
