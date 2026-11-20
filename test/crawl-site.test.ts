import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUsd } from "../src/money.js";
import {
  SensesRequestError,
  type CrawlSiteRequest,
  type CrawlSiteResult,
  type FeedRequest,
  type FeedResult,
  type SeePageRequest,
  type SeePageResult,
  type SensesClient,
} from "../src/senses-client.js";
import { createSensesServer, type SensesServerOptions } from "../senses/src/server.ts";
import {
  allowedByRobots,
  CRAWL_BUDGET_MS,
  CRAWLER_UA,
  crawlDelaySeconds,
  defaultLoadDocument,
  hostDelayMs,
  MAX_CRAWL_DELAY_MS,
  MIN_HOST_DELAY_MS,
  THIN_TEXT_CHARS,
  type LoadDocument,
} from "../senses/src/crawl.ts";
import type { FetchHop } from "../senses/src/safety.ts";
import { harness } from "./helpers.js";

const PUBLIC = "93.184.216.34";
const LONG = `${"The public log is plain HTML. ".repeat(6)}End.`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function resolveHost(host: string): Promise<string[]> {
  if (host === "fixture.example" || host === "other.example") return Promise.resolve([PUBLIC]);
  return Promise.resolve([host]);
}

async function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  return {
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function startSenses(options: SensesServerOptions = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createSensesServer({ resolveHost, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("senses did not bind");
  return {
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function postCrawl(port: number, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/crawl`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function rewritingLoad(extra?: (url: string) => void): LoadDocument {
  return async (url, init) => {
    extra?.(url);
    const target = new URL(url);
    if (target.hostname === "fixture.example" || target.hostname === "other.example") target.hostname = "127.0.0.1";
    return defaultLoadDocument(target.href, init);
  };
}

function pagesOf(body: Record<string, unknown>): { url: string; title: string; markdown: string }[] {
  return Array.isArray(body.pages) ? (body.pages as { url: string; title: string; markdown: string }[]) : [];
}

function skippedOf(body: Record<string, unknown>): { url: string; reason: string }[] {
  return Array.isArray(body.skipped) ? (body.skipped as { url: string; reason: string }[]) : [];
}

function html(title: string, inner: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${LONG}</p>${inner}</main></body></html>`;
}

describe("crawl robots and limits", () => {
  it("uses a one second floor, a ten second crawl-delay cap, and an eighty character render threshold", () => {
    expect(MIN_HOST_DELAY_MS).toBe(1_000);
    expect(MAX_CRAWL_DELAY_MS).toBe(10_000);
    expect(CRAWL_BUDGET_MS).toBe(120_000);
    expect(THIN_TEXT_CHARS).toBe(80);
    expect(CRAWLER_UA).toContain("AutomatonSenses");
    expect(hostDelayMs(undefined, MIN_HOST_DELAY_MS)).toBe(1_000);
    expect(hostDelayMs(0.5, MIN_HOST_DELAY_MS)).toBe(1_000);
    expect(hostDelayMs(5, MIN_HOST_DELAY_MS)).toBe(5_000);
    expect(hostDelayMs(15, MIN_HOST_DELAY_MS)).toBe(10_000);
    expect(LONG.length).toBeGreaterThanOrEqual(THIN_TEXT_CHARS);
  });

  it("lets the longest robots rule win, and prefers the crawler's own user agent over star", () => {
    const robots = ["User-agent: *", "Disallow: /private", "Allow: /private/open", ""].join("\n");
    expect(allowedByRobots(robots, "/private")).toBe(false);
    expect(allowedByRobots(robots, "/private/room")).toBe(false);
    expect(allowedByRobots(robots, "/private/open")).toBe(true);
    expect(allowedByRobots(robots, "/public")).toBe(true);
    const specific = ["User-agent: *", "Disallow: /secret", "Crawl-delay: 9", "", "User-agent: AutomatonSenses", "Disallow:", "Crawl-delay: 2", ""].join(
      "\n",
    );
    expect(allowedByRobots(specific, "/secret")).toBe(true);
    expect(crawlDelaySeconds(specific)).toBe(2);
    expect(crawlDelaySeconds(robots)).toBeUndefined();
  });

  it("honours Disallow and does not fetch that path", async () => {
    const hits: string[] = [];
    const fixture = await listen((req, res) => {
      const url = req.url ?? "";
      hits.push(url);
      if (url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /private\nAllow: /private/open\n");
        return;
      }
      if (url === "/private") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(html("Secret", "should not be read"));
        return;
      }
      const title = url === "/" ? "Home" : url.slice(1);
      const links =
        url === "/"
          ? `<a href="/public">Public</a><a href="/private">Private</a><a href="/private/open">Open</a><form action="/submit" method="post"><button>send</button></form><a href="/notes.pdf">pdf</a>`
          : "";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html(title, links));
    });
    const senses = await startSenses({
      minHostDelayMs: 0,
      loadDocument: rewritingLoad(),
      browse: async () => {
        throw new Error("browse should not run");
      },
    });
    try {
      const result = await postCrawl(senses.port, { url: `http://fixture.example:${fixture.port}/`, max_pages: 10 });
      expect(result.status).toBe(200);
      expect(result.body.robots).toBe("ok");
      const pages = pagesOf(result.body);
      expect(pages.map((page) => new URL(page.url).pathname).sort()).toEqual(["/", "/private/open", "/public"]);
      expect(pages.find((page) => new URL(page.url).pathname === "/")?.title).toBe("Home");
      expect(pages.find((page) => new URL(page.url).pathname === "/")?.markdown).toContain("plain HTML");
      const skipped = skippedOf(result.body);
      expect(skipped.some((item) => new URL(item.url).pathname === "/private" && item.reason === "robots")).toBe(true);
      expect(skipped.some((item) => item.url.endsWith("/notes.pdf") && item.reason === "file")).toBe(true);
      expect(hits).not.toContain("/private");
      expect(hits).not.toContain("/submit");
      expect(hits).not.toContain("/notes.pdf");
    } finally {
      await senses.close();
      await fixture.close();
    }
  });

  it("stops at max_pages", async () => {
    const hits: string[] = [];
    const fixture = await listen((req, res) => {
      hits.push(req.url ?? "");
      const links = req.url === "/" ? `<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>` : "";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html(req.url ?? "", links));
    });
    const senses = await startSenses({ minHostDelayMs: 0, loadDocument: rewritingLoad() });
    try {
      const result = await postCrawl(senses.port, { url: `http://fixture.example:${fixture.port}/`, max_pages: 1 });
      expect(result.status).toBe(200);
      expect(pagesOf(result.body)).toHaveLength(1);
      expect(new URL(pagesOf(result.body)[0]?.url ?? "").pathname).toBe("/");
      expect(hits.filter((hit) => hit === "/a" || hit === "/b" || hit === "/c")).toEqual([]);
      const tooBig = await postCrawl(senses.port, { url: `http://fixture.example:${fixture.port}/`, max_pages: 21 });
      const tooSmall = await postCrawl(senses.port, { url: `http://fixture.example:${fixture.port}/`, max_pages: 0 });
      expect(tooBig.status).toBe(400);
      expect(tooSmall.status).toBe(400);
    } finally {
      await senses.close();
      await fixture.close();
    }
  });

  it("waits at least one second between hits on the same host", async () => {
    const hits: { url: string; at: number }[] = [];
    const fixture = await listen((req, res) => {
      hits.push({ url: req.url ?? "", at: Date.now() });
      const links = req.url === "/" ? `<a href="/next">next</a>` : "";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("Timed", links));
    });
    const senses = await startSenses({ loadDocument: rewritingLoad() });
    try {
      const result = await postCrawl(senses.port, { url: `http://fixture.example:${fixture.port}/`, max_pages: 2 });
      expect(result.status).toBe(200);
      expect(pagesOf(result.body)).toHaveLength(2);
      expect(hits.length).toBeGreaterThanOrEqual(3);
      for (let index = 1; index < hits.length; index += 1) {
        expect(hits[index]!.at - hits[index - 1]!.at).toBeGreaterThanOrEqual(MIN_HOST_DELAY_MS);
      }
    } finally {
      await senses.close();
      await fixture.close();
    }
  }, 20_000);

  it("uses a robots crawl-delay when it is larger than the floor", async () => {
    const hits: number[] = [];
    const fixture = await listen((req, res) => {
      hits.push(Date.now());
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nCrawl-delay: 0.05\n");
        return;
      }
      const links = req.url === "/" ? `<a href="/next">next</a>` : "";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("Delayed", links));
    });
    const senses = await startSenses({ minHostDelayMs: 0, loadDocument: rewritingLoad() });
    try {
      const result = await postCrawl(senses.port, { url: `http://fixture.example:${fixture.port}/`, max_pages: 2 });
      expect(result.status).toBe(200);
      expect(hits.length).toBeGreaterThanOrEqual(3);
      for (let index = 1; index < hits.length; index += 1) {
        expect(hits[index]! - hits[index - 1]!).toBeGreaterThanOrEqual(45);
      }
    } finally {
      await senses.close();
      await fixture.close();
    }
  });

  it("stays on the same host unless same_domain is false", async () => {
    const loaded: string[] = [];
    let port = 0;
    const fixture = await listen((req, res) => {
      if (req.url === "/robots.txt" || req.url === "/sitemap.xml") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("missing");
        return;
      }
      const links =
        req.url === "/"
          ? `<a href="/inside">inside</a><a href="http://other.example:${port}/outside">outside</a>`
          : "";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html(req.url === "/outside" ? "Outside" : "Inside", links));
    });
    port = fixture.port;
    const senses = await startSenses({
      minHostDelayMs: 0,
      loadDocument: rewritingLoad((url) => loaded.push(url)),
    });
    try {
      const same = await postCrawl(senses.port, { url: `http://fixture.example:${port}/` });
      expect(same.status).toBe(200);
      expect(same.body.robots).toBe("missing");
      const samePaths = pagesOf(same.body).map((page) => new URL(page.url).pathname).sort();
      expect(samePaths).toEqual(["/", "/inside"]);
      expect(skippedOf(same.body).some((item) => item.url.includes("other.example") && item.reason === "other host")).toBe(true);
      expect(loaded.some((url) => url.includes("other.example"))).toBe(false);

      loaded.length = 0;
      const wider = await postCrawl(senses.port, { url: `http://fixture.example:${port}/`, same_domain: false, max_pages: 5 });
      expect(wider.status).toBe(200);
      expect(pagesOf(wider.body).some((page) => page.url.includes("other.example") && page.title === "Outside")).toBe(true);
      expect(loaded.some((url) => url.includes("other.example"))).toBe(true);
    } finally {
      await senses.close();
      await fixture.close();
    }
  });

  it("refuses private and link-local links and redirects", async () => {
    const hits: string[] = [];
    const loaded: string[] = [];
    const fixture = await listen((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/jump") {
        res.writeHead(302, { location: "http://127.0.0.1/secret" });
        res.end();
        return;
      }
      if (req.url === "/to-meta") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
        res.end();
        return;
      }
      if (req.url === "/to-ten") {
        res.writeHead(302, { location: "http://10.1.2.3/hidden" });
        res.end();
        return;
      }
      if (req.url === "/secret") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(html("Secret", "nope"));
        return;
      }
      const links = `<a href="http://127.0.0.1/secret">loop</a><a href="http://169.254.169.254/latest/meta-data">meta</a><a href="http://10.2.2.2/lan">lan</a><a href="/to-ten">hop</a>`;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("Index", links));
    });
    const senses = await startSenses({
      minHostDelayMs: 0,
      loadDocument: rewritingLoad((url) => loaded.push(url)),
    });
    try {
      const jump = await postCrawl(senses.port, { url: `http://fixture.example:${fixture.port}/jump` });
      const meta = await postCrawl(senses.port, { url: "http://169.254.169.254/latest/meta-data" });
      const ten = await postCrawl(senses.port, { url: "http://10.0.0.1/" });
      expect(jump.status).toBe(400);
      expect(String(jump.body.error)).toMatch(/private|link-local/i);
      expect(meta.status).toBe(400);
      expect(String(meta.body.error)).toMatch(/private|link-local/i);
      expect(ten.status).toBe(400);
      expect(String(ten.body.error)).toMatch(/private|link-local/i);
      expect(hits).not.toContain("/secret");
      expect(loaded.some((url) => url.includes("127.0.0.1") || url.includes("169.254.169.254") || url.includes("10.1.2.3"))).toBe(false);

      hits.length = 0;
      loaded.length = 0;
      const linked = await postCrawl(senses.port, {
        url: `http://fixture.example:${fixture.port}/`,
        same_domain: false,
        max_pages: 5,
      });
      expect(linked.status).toBe(200);
      const reasons = skippedOf(linked.body).map((item) => item.reason).join("\n");
      expect(reasons).toMatch(/private|link-local/i);
      expect(skippedOf(linked.body).some((item) => item.url.includes("127.0.0.1"))).toBe(true);
      expect(skippedOf(linked.body).some((item) => item.url.includes("169.254.169.254"))).toBe(true);
      expect(skippedOf(linked.body).some((item) => item.url.includes("10.2.2.2"))).toBe(true);
      expect(skippedOf(linked.body).some((item) => item.url.includes("/to-ten") && /private|link-local/i.test(item.reason))).toBe(true);
      expect(hits).toContain("/to-ten");
      expect(hits).not.toContain("/secret");
      expect(loaded.some((url) => /127\.0\.0\.1|169\.254\.169\.254|10\.2\.2\.2|10\.1\.2\.3/.test(url))).toBe(false);
    } finally {
      await senses.close();
      await fixture.close();
    }
  });

  it("refuses a deny-listed host", async () => {
    const loaded: string[] = [];
    const fixture = await listen((req, res) => {
      const links = req.url === "/" ? `<a href="https://cdn.blocked.example/a">cdn</a>` : "";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("Open", links));
    });
    const senses = await startSenses({
      minHostDelayMs: 0,
      loadDocument: rewritingLoad((url) => loaded.push(url)),
    });
    try {
      const direct = await postCrawl(senses.port, { url: "https://blocked.example/a", denyHosts: ["blocked.example"] });
      expect(direct.status).toBe(400);
      expect(String(direct.body.error)).toContain("blocked.example");
      const linked = await postCrawl(senses.port, {
        url: `http://fixture.example:${fixture.port}/`,
        same_domain: false,
        denyHosts: ["blocked.example"],
      });
      expect(linked.status).toBe(200);
      expect(skippedOf(linked.body).some((item) => item.url.includes("blocked.example") && item.reason.includes("blocked.example"))).toBe(
        true,
      );
      expect(loaded.some((url) => url.includes("blocked.example"))).toBe(false);
    } finally {
      await senses.close();
      await fixture.close();
    }
  });

  it("treats a 4xx robots.txt as allow-all and a 5xx as disallow-all", async () => {
    const hits: string[] = [];
    let robotsStatus = 404;
    const fixture = await listen((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/robots.txt") {
        res.writeHead(robotsStatus, { "content-type": "text/plain" });
        res.end(robotsStatus === 500 ? "down" : "missing");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("Visible", ""));
    });
    const senses = await startSenses({ minHostDelayMs: 0, loadDocument: rewritingLoad() });
    try {
      const missing = await postCrawl(senses.port, { url: `http://fixture.example:${fixture.port}/page`, max_pages: 1 });
      expect(missing.status).toBe(200);
      expect(missing.body.robots).toBe("missing");
      expect(pagesOf(missing.body)).toHaveLength(1);

      hits.length = 0;
      robotsStatus = 500;
      const down = await postCrawl(senses.port, { url: `http://fixture.example:${fixture.port}/page`, max_pages: 1 });
      expect(down.status).toBe(200);
      expect(down.body.robots).toBe("unreachable");
      expect(pagesOf(down.body)).toEqual([]);
      expect(skippedOf(down.body).some((item) => item.reason === "robots")).toBe(true);
      expect(hits).toEqual(["/robots.txt"]);
    } finally {
      await senses.close();
      await fixture.close();
    }
  });

  it("renders with the browser only when the HTTP body has almost no text", async () => {
    let rendered = 0;
    const fixture = await listen((req, res) => {
      if (req.url === "/thin") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><html><head><title>Shell</title></head><body><div id='app'></div></body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("Thick", ""));
    });
    const senses = await startSenses({
      minHostDelayMs: 0,
      loadDocument: rewritingLoad(),
      browse: async (input) => {
        rendered += 1;
        return { title: "Rendered", markdown: "Rendered from the shell.", links: [], url: input.url } as {
          title: string;
          markdown: string;
          links: string[];
        };
      },
    });
    try {
      const thin = await postCrawl(senses.port, { url: `http://fixture.example:${fixture.port}/thin`, max_pages: 1 });
      expect(thin.status).toBe(200);
      expect(rendered).toBe(1);
      expect(pagesOf(thin.body)[0]?.title).toBe("Rendered");
      expect(pagesOf(thin.body)[0]?.markdown).toContain("Rendered from the shell.");
      const thick = await postCrawl(senses.port, { url: `http://fixture.example:${fixture.port}/thick`, max_pages: 1 });
      expect(thick.status).toBe(200);
      expect(rendered).toBe(1);
      expect(pagesOf(thick.body)[0]?.markdown).toContain("plain HTML");
    } finally {
      await senses.close();
      await fixture.close();
    }
  });

  it("shares the one-at-a-time queue with see", async () => {
    let active = 0;
    let max = 0;
    const enter = async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
    };
    const fixture = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("Queued", ""));
    });
    const loadDocument: LoadDocument = async (url, init) => {
      await enter();
      return rewritingLoad()(url, init);
    };
    const senses = await startSenses({
      minHostDelayMs: 0,
      loadDocument,
      fetchHop: (async () => ({ status: 200, location: null })) as FetchHop,
      browse: async () => {
        await enter();
        return { title: "Seen", markdown: "one", links: [] };
      },
    });
    try {
      const [crawl, see] = await Promise.all([
        postCrawl(senses.port, { url: `http://fixture.example:${fixture.port}/`, max_pages: 1 }),
        fetch(`http://127.0.0.1:${senses.port}/see`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: `http://${PUBLIC}/page` }),
        }),
      ]);
      expect(crawl.status).toBe(200);
      expect(see.status).toBe(200);
      expect(max).toBe(1);
    } finally {
      await senses.close();
      await fixture.close();
    }
  });
});

class LedgerProbe implements SensesClient {
  calls = 0;
  balanceAtCall: number[] = [];
  lastMax = 0;
  lastSame = true;
  mode: "ok" | "throw" | "refuse" = "ok";
  pageCount = 2;
  markdown = `${"m".repeat(2_000)}UNIQUE_TAIL`;

  constructor(private readonly balance: () => number) {}

  async see(_input: SeePageRequest): Promise<SeePageResult> {
    throw new Error("see was not stubbed");
  }

  async feed(_input: FeedRequest): Promise<FeedResult> {
    throw new Error("feed was not stubbed");
  }

  async browse(): Promise<import("../src/senses-client.js").BrowseTaskResult> {
    throw new Error("browse was not stubbed");
  }

  async crawl(input: CrawlSiteRequest): Promise<CrawlSiteResult> {
    this.calls += 1;
    this.balanceAtCall.push(this.balance());
    this.lastMax = input.maxPages;
    this.lastSame = input.sameDomain;
    if (this.mode === "throw") throw new Error("crawl crashed");
    if (this.mode === "refuse") throw new SensesRequestError("redirected to a private address", 400);
    return {
      robots: "ok",
      pages: Array.from({ length: this.pageCount }, (_, index) => ({
        url: `${input.url}/p${index}`,
        title: `Page ${index}`,
        markdown: this.markdown,
      })),
      skipped: [{ url: `${input.url}/private`, reason: "robots" }],
    };
  }
}

function rigWithProbe(overrides: Record<string, string> = {}) {
  let read = () => 0;
  const probe = new LedgerProbe(() => read());
  const rig = harness(overrides, undefined, undefined, probe);
  cleanups.push(rig.cleanup);
  return {
    rig,
    probe,
    bind(agentId: string) {
      read = () => rig.swarm.snapshot(agentId).balanceUnits;
    },
  };
}

async function funded(units: string, overrides: Record<string, string> = {}) {
  const box = rigWithProbe(overrides);
  const created = await box.rig.swarm.createAgent({ name: "crawler" });
  if (!created.ok) throw new Error(created.error);
  if (units !== "0") box.rig.swarm.ownerTopup(created.value.id, parseUsd(units), "seed");
  box.bind(created.value.id);
  return { ...box, id: created.value.id };
}

function crawlEvents(rig: ReturnType<typeof harness>, agentId: string): { kind: string; message: string }[] {
  return rig.db
    .prepare("SELECT kind, message FROM events WHERE agent_id = ? AND kind = 'crawl_site' ORDER BY id")
    .all(agentId) as { kind: string; message: string }[];
}

describe("crawl_site ledger", () => {
  it("prices a page and caps the crawl", () => {
    const { rig } = rigWithProbe();
    expect(rig.config.crawlPagePriceUnits).toBe(parseUsd("0.001"));
    expect(rig.config.crawlHourlyLimit).toBe(5);
    expect(rig.config.crawlMaxPages).toBe(20);
    expect(rig.config.toolCosts.crawl_site).toBe(parseUsd("0.001"));
  });

  it("reviews the url before charging", async () => {
    const { rig, probe, id } = await funded("1");
    const before = rig.swarm.snapshot(id).balanceUnits;
    const refused = await rig.swarm.handleTool(id, {
      id: "crawl-private",
      name: "crawl_site",
      arguments: { url: "http://10.0.0.1/latest" },
    });
    const metadata = await rig.swarm.handleTool(id, {
      id: "crawl-meta",
      name: "crawl_site",
      arguments: { url: "http://169.254.169.254/latest/meta-data" },
    });
    expect(refused.ok).toBe(false);
    expect(metadata.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/private|link-local/i);
    expect(probe.calls).toBe(0);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(before);
    const events = crawlEvents(rig, id);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.message.includes("outcome=refused") && event.message.includes("cost=0"))).toBe(true);
  });

  it("refuses a constitution deny host before charging", async () => {
    const prior = process.env.CONSTITUTION_DENY_HOSTS;
    process.env.CONSTITUTION_DENY_HOSTS = "blocked.example";
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      const { rig, probe, id } = await funded("1");
      const before = rig.swarm.snapshot(id).balanceUnits;
      const refused = await rig.swarm.handleTool(id, {
        id: "crawl-deny",
        name: "crawl_site",
        arguments: { url: "https://news.blocked.example/story" },
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toContain("blocked.example");
      expect(probe.calls).toBe(0);
      expect(rig.swarm.snapshot(id).balanceUnits).toBe(before);
      expect(logs.some((line) => line.includes("constitution deny"))).toBe(true);
      expect(crawlEvents(rig, id)[0]?.message).toContain("outcome=refused");
    } finally {
      spy.mockRestore();
      if (prior === undefined) delete process.env.CONSTITUTION_DENY_HOSTS;
      else process.env.CONSTITUTION_DENY_HOSTS = prior;
    }
  });

  it("debits only pages actually fetched, and a zero-page crawl costs nothing", async () => {
    const { rig, probe, id } = await funded("1");
    const start = rig.swarm.snapshot(id).balanceUnits;
    const price = parseUsd("0.001");
    probe.pageCount = 2;
    const crawled = await rig.swarm.handleTool(id, {
      id: "crawl-ok",
      name: "crawl_site",
      arguments: { url: "http://93.184.216.34/start", max_pages: 4 },
    });
    expect(crawled.ok).toBe(true);
    expect(probe.calls).toBe(1);
    expect(probe.lastMax).toBe(4);
    expect(probe.lastSame).toBe(true);
    expect(probe.balanceAtCall[0]).toBe(start - price * 4);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - price * 2);
    const message = crawlEvents(rig, id)[0]?.message ?? "";
    expect(message).toContain("outcome=ok");
    expect(message).toContain(`cost=${price * 2}`);
    expect(message).toContain("fetched=2");
    expect(message).toContain("skipped=1");
    expect(message).toContain("http://93.184.216.34/start");
    if (crawled.ok) {
      expect(crawled.output).toContain("Page 0");
      expect(crawled.output).toContain("http://93.184.216.34/start/p0");
      expect(crawled.output).toContain("m".repeat(200));
      expect(crawled.output).not.toContain("UNIQUE_TAIL");
      expect(crawled.output).toContain("evidence/");
    }
    const agent = rig.db.prepare("SELECT workspace FROM agents WHERE id = ?").get(id) as { workspace: string };
    const files = fs.readdirSync(path.join(agent.workspace, "evidence"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d+-[0-9a-f]{8}-crawl\.json$/);
    const saved = JSON.parse(fs.readFileSync(path.join(agent.workspace, "evidence", files[0] ?? ""), "utf8")) as CrawlSiteResult;
    expect(saved.pages[0]?.markdown).toContain("UNIQUE_TAIL");
    expect(saved.robots).toBe("ok");
    const spent = rig.db.prepare("SELECT COALESCE(SUM(amount_units), 0) AS n FROM spend WHERE agent_id = ?").get(id) as { n: number };
    expect(spent.n).toBe(price * 2);

    probe.pageCount = 0;
    const empty = await rig.swarm.handleTool(id, {
      id: "crawl-empty",
      name: "crawl_site",
      arguments: { url: "http://93.184.216.34/start", max_pages: 3 },
    });
    expect(empty.ok).toBe(true);
    expect(probe.balanceAtCall[1]).toBe(start - price * 2 - price * 3);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - price * 2);
    expect(crawlEvents(rig, id).at(-1)?.message).toContain("cost=0");
    expect(crawlEvents(rig, id).at(-1)?.message).toContain("fetched=0");
  });

  it("refuses an unaffordable pre-authorization at no cost", async () => {
    const price = parseUsd("0.001");
    const { rig, probe, id } = await funded("0.009");
    const before = rig.swarm.snapshot(id).balanceUnits;
    const refused = await rig.swarm.handleTool(id, {
      id: "crawl-poor",
      name: "crawl_site",
      arguments: { url: "http://93.184.216.34/start" },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/too low|cap/i);
    expect(probe.calls).toBe(0);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(before);
    expect(crawlEvents(rig, id)[0]?.message).toContain("outcome=unaffordable");
    expect(crawlEvents(rig, id)[0]?.message).toContain("cost=0");
    const affordable = await rig.swarm.handleTool(id, {
      id: "crawl-one",
      name: "crawl_site",
      arguments: { url: "http://93.184.216.34/start", max_pages: 1 },
    });
    expect(affordable.ok).toBe(true);
    expect(probe.calls).toBe(1);
    expect(probe.lastMax).toBe(1);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(before - price);
  });

  it("refuses the hourly limit without charging", async () => {
    const { rig, probe, id } = await funded("1", { CRAWL_HOURLY_LIMIT: "2" });
    const start = rig.swarm.snapshot(id).balanceUnits;
    const price = parseUsd("0.001");
    probe.pageCount = 1;
    for (const callId of ["c1", "c2"]) {
      const seen = await rig.swarm.handleTool(id, {
        id: callId,
        name: "crawl_site",
        arguments: { url: "http://93.184.216.34/start", max_pages: 1 },
      });
      expect(seen.ok).toBe(true);
    }
    const blocked = await rig.swarm.handleTool(id, {
      id: "c3",
      name: "crawl_site",
      arguments: { url: "http://93.184.216.34/start", max_pages: 1 },
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain("hourly limit is 2");
    expect(probe.calls).toBe(2);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - price * 2);
    expect(crawlEvents(rig, id).at(-1)?.message).toContain("outcome=limit");
    expect(crawlEvents(rig, id).at(-1)?.message).toContain("cost=0");
    rig.clock.advance(3_600_000);
    const again = await rig.swarm.handleTool(id, {
      id: "c4",
      name: "crawl_site",
      arguments: { url: "http://93.184.216.34/start", max_pages: 1 },
    });
    expect(again.ok).toBe(true);
    expect(probe.calls).toBe(3);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - price * 3);
  });

  it("refunds a senses error", async () => {
    const { rig, probe, id } = await funded("1");
    const start = rig.swarm.snapshot(id).balanceUnits;
    const price = parseUsd("0.001");
    probe.mode = "throw";
    const crashed = await rig.swarm.handleTool(id, {
      id: "crawl-crash",
      name: "crawl_site",
      arguments: { url: "http://93.184.216.34/start", max_pages: 4 },
    });
    expect(crashed.ok).toBe(false);
    if (!crashed.ok) expect(crashed.reason).toContain("crawl crashed");
    expect(probe.calls).toBe(1);
    expect(probe.balanceAtCall[0]).toBe(start - price * 4);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start);
    const spent = rig.db.prepare("SELECT COALESCE(SUM(amount_units), 0) AS n FROM spend WHERE agent_id = ?").get(id) as { n: number };
    expect(spent.n).toBe(0);
    expect(crawlEvents(rig, id)[0]?.message).toContain("outcome=error");
    expect(crawlEvents(rig, id)[0]?.message).toContain("cost=0");

    probe.mode = "refuse";
    const refused = await rig.swarm.handleTool(id, {
      id: "crawl-refuse",
      name: "crawl_site",
      arguments: { url: "http://93.184.216.34/start", max_pages: 2 },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("private address");
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start);
    expect(spent.n).toBe(0);
    const spentAfter = rig.db.prepare("SELECT COALESCE(SUM(amount_units), 0) AS n FROM spend WHERE agent_id = ?").get(id) as { n: number };
    expect(spentAfter.n).toBe(0);
  });
});
