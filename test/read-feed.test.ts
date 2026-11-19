import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { classifyAgentPath, executeLocalTool, getRefRoot, setRefRoot, TOOL_DEFINITIONS } from "../src/agent/tools.js";
import { loadConfig } from "../src/config.js";
import { parseUsd } from "../src/money.js";
import { DockerRuntime } from "../src/runtime.js";
import {
  HttpSensesClient,
  SensesRequestError,
  type CrawlSiteRequest,
  type CrawlSiteResult,
  type FeedRequest,
  type FeedResult,
  type SeePageRequest,
  type SeePageResult,
  type SensesClient,
} from "../src/senses-client.js";
import { parseArchive } from "../senses/feeds/archive.ts";
import { parseArxiv } from "../senses/feeds/arxiv.ts";
import { blueskyRequiresAuth, parseBluesky } from "../senses/feeds/bluesky.ts";
import { readCapped, type FeedContext } from "../senses/feeds/fetch.ts";
import { parseHn } from "../senses/feeds/hn.ts";
import { readBluesky } from "../senses/feeds/bluesky.ts";
import { parseReddit, readReddit, redditUrl, resetRedditSchedule } from "../senses/feeds/reddit.ts";
import { parseRss } from "../senses/feeds/rss.ts";
import { FEED_SOURCES, DEFAULT_REDDIT_USER_AGENT } from "../senses/feeds/types.ts";
import { parsePageviews } from "../senses/feeds/wikimedia-pageviews.ts";
import { parseWikipedia } from "../senses/feeds/wikipedia.ts";
import { parseX402Bazaar } from "../senses/feeds/x402-bazaar.ts";
import { createSensesServer, type SensesServerOptions } from "../senses/src/server.ts";
import { harness } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "test", "fixtures", "feeds");
const PUBLIC = "93.184.216.34";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  resetRedditSchedule();
  while (cleanups.length) await cleanups.pop()?.();
});

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixtures, name), "utf8");
}

function resolveHost(): Promise<string[]> {
  return Promise.resolve([PUBLIC]);
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

function jsonResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
}

describe("feed fixtures", () => {
  it("parses every recorded adapter response and caps at 25", () => {
    const hn = parseHn(readFixture("hn.json"));
    expect(hn).toHaveLength(2);
    expect(hn[0]).toMatchObject({
      source: "hn",
      id: "123",
      title: "Show HN: Ears",
      url: "https://example.com/ears",
      text: "Listen to public feeds.",
      author: "pg",
      score: 42,
      created_at: "2026-11-01T00:00:00.000Z",
    });
    expect(hn[1]).toMatchObject({
      id: "124",
      title: "Ask HN: Feeds",
      url: "https://news.ycombinator.com/item?id=124",
      text: "A comment.",
    });
    const many = parseHn(
      JSON.stringify({
        hits: Array.from({ length: 30 }, (_, index) => ({
          objectID: String(index),
          title: `T${index}`,
          url: `https://example.com/${index}`,
        })),
      }),
    );
    expect(many).toHaveLength(25);

    const post = parseBluesky(readFixture("bluesky.json"))[0];
    expect(post).toMatchObject({
      source: "bluesky",
      id: "at://did:plc:example/app.bsky.feed.post/abc123",
      url: "https://bsky.app/profile/ada.bsky.social/post/abc123",
      author: "ada.bsky.social",
      score: 7,
      text: "Public feeds, no key. Second line.",
    });
    expect(blueskyRequiresAuth({ status: 401, headers: new Headers({ "content-type": "application/json" }), body: readFixture("bluesky-auth.json"), finalUrl: "" })).toBe(true);

    const wiki = parseWikipedia(readFixture("wikipedia.json"))[0];
    expect(wiki).toMatchObject({
      source: "wikipedia",
      id: "6678",
      title: "Cat",
      url: "https://en.wikipedia.org/wiki/Cat",
      text: "The cat is a pet.",
      score: 100,
    });

    const views = parsePageviews(readFixture("pageviews.json"));
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({
      source: "wikimedia-pageviews",
      title: "Cat",
      url: "https://en.wikipedia.org/wiki/Cat",
      text: "10 views",
      score: 10,
      created_at: "2026-11-01T00:00:00.000Z",
    });

    const paper = parseArxiv(readFixture("arxiv.xml"))[0];
    expect(paper).toMatchObject({
      source: "arxiv",
      title: "Quantum ears",
      url: "http://arxiv.org/abs/1234.5678",
      text: "A paper about listening.",
      author: "Ada Lovelace",
    });

    const film = parseArchive(readFixture("archive.json"))[0];
    expect(film).toMatchObject({
      source: "archive",
      id: "item-1",
      title: "Public Domain Film",
      url: "https://archive.org/details/item-1",
      text: "A film.",
      author: "Prelinger",
      score: 8,
    });

    const rss = parseRss(readFixture("rss.xml"));
    expect(rss).toHaveLength(2);
    expect(rss[0]).toMatchObject({
      source: "rss",
      title: "Ears & Feeds",
      url: "https://example.com/ears",
      text: "Hello from the feed.",
      author: "ada@example.com",
    });

    const service = parseX402Bazaar(readFixture("x402.json"))[0];
    expect(service).toMatchObject({
      source: "x402-bazaar",
      title: "Weather",
      url: "https://example.com/weather",
      text: "A public forecast.",
      score: 4,
    });

    const reddit = parseReddit(readFixture("reddit-search.json"))[0];
    expect(reddit).toMatchObject({
      source: "reddit",
      id: "t3_abc123",
      title: "Key-free JSON",
      url: "https://example.com/post",
      text: "Public listing.",
      author: "reader",
      score: 9,
    });
    const comment = parseReddit(readFixture("reddit-comments.json"))[0];
    expect(comment).toMatchObject({
      id: "t1_c1",
      title: "Key-free JSON",
      url: "https://www.reddit.com/r/test/comments/abc123/keyfree_json/c1/",
      text: "A comment.",
    });
    expect(redditUrl("ears", {})).toBe("https://www.reddit.com/search.json?q=ears&limit=25&raw_json=1");
    expect(redditUrl("ears", { subreddit: "news" })).toContain("https://www.reddit.com/r/news/search.json?");
    expect(redditUrl("ears", { subreddit: "news", kind: "new" })).toBe("https://www.reddit.com/r/news/new.json?limit=25&raw_json=1");
    expect(redditUrl("abc123", { kind: "comments", subreddit: "news" })).toBe(
      "https://www.reddit.com/r/news/comments/abc123.json?limit=25&raw_json=1",
    );
  });

  it("has no x or twitter adapter", () => {
    const names = fs.readdirSync(path.join(root, "senses", "feeds"));
    expect(names.some((name) => /twitter|^x\.ts$/i.test(name))).toBe(false);
    expect(FEED_SOURCES).not.toContain("twitter");
    expect(FEED_SOURCES).not.toContain("x");
    const tool = TOOL_DEFINITIONS.find((item) => item.name === "read_feed");
    const source = tool?.parameters.source as { enum?: string[] };
    expect(source.enum).toEqual([...FEED_SOURCES]);
    expect(source.enum).not.toContain("twitter");
    expect(source.enum).not.toContain("x");
  });

  it("refuses an unknown source", async () => {
    const senses = await startSenses({ feedFetch: async () => jsonResponse("{}") });
    cleanups.push(() => senses.close());
    const response = await fetch(`http://127.0.0.1:${senses.port}/feed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "twitter", query: "cats" }),
    });
    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("unknown source");
  });

  it("drops a private item url and refuses a redirect onto loopback", async () => {
    const calls: string[] = [];
    const senses = await startSenses({
      feedFetch: async (url) => {
        calls.push(url);
        if (url.startsWith("https://example.com/jump")) {
          return new Response("", { status: 302, headers: { location: "http://127.0.0.1/secret" } });
        }
        return new Response(readFixture("rss.xml"), { status: 200, headers: { "content-type": "application/rss+xml" } });
      },
    });
    cleanups.push(() => senses.close());
    const kept = await fetch(`http://127.0.0.1:${senses.port}/feed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "rss", query: "https://example.com/feed.xml" }),
    });
    const keptBody = (await kept.json()) as { items: { url: string }[] };
    expect(kept.status).toBe(200);
    expect(keptBody.items.map((item) => item.url)).toEqual(["https://example.com/ears"]);
    const jumped = await fetch(`http://127.0.0.1:${senses.port}/feed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "rss", query: "https://example.com/jump" }),
    });
    const jumpedBody = (await jumped.json()) as { error?: string };
    expect(jumped.status).toBe(400);
    expect(jumpedBody.error).toMatch(/private|link-local/i);
    expect(calls.filter((url) => url.includes("127.0.0.1"))).toHaveLength(0);
  });

  it("stops a feed body over 2 MB", async () => {
    const huge = new Response("x".repeat(20));
    await expect(readCapped(huge, 8)).rejects.toThrow(/2 MB/);
  });
});

function feedContext(fetchImpl: typeof fetch, now = () => 0, sleep: (ms: number) => Promise<void> = async () => undefined): FeedContext {
  return {
    query: "ears",
    options: { subreddit: "test" },
    denyHosts: [],
    resolveHost,
    fetchImpl,
    now,
    sleep,
    userAgent: DEFAULT_REDDIT_USER_AGENT,
  };
}

describe("reddit blocks", () => {
  it("returns blocked from a 403 fixture and does not retry", async () => {
    let fetches = 0;
    let agent = "";
    const result = await readReddit(
      feedContext(async (_url, init) => {
        fetches += 1;
        if (fetches > 1) throw new Error("reddit retried a 403");
        agent = new Headers(init?.headers).get("user-agent") ?? "";
        return jsonResponse(readFixture("reddit-403.html"), 403, { "content-type": "text/html" });
      }),
    );
    expect(fetches).toBe(1);
    expect(agent).toBe(DEFAULT_REDDIT_USER_AGENT);
    expect(result).toMatchObject({ blocked: true, status: 403, reason: "reddit forbidden" });
  });

  it("backs off once on a 429 fixture and does not loop", async () => {
    let fetches = 0;
    let clock = 0;
    const result = await readReddit(
      feedContext(
        async () => {
          fetches += 1;
          if (fetches > 2) throw new Error("reddit retried more than once");
          return jsonResponse(readFixture("reddit-429.json"), 429, { "retry-after": "0" });
        },
        () => clock,
        async (ms) => {
          clock += ms;
        },
      ),
    );
    expect(fetches).toBe(2);
    expect(result).toMatchObject({ blocked: true, status: 429, reason: "reddit rate limited" });
  });

  it("does not retry when Retry-After is longer than the feed timeout", async () => {
    let fetches = 0;
    const result = await readReddit(
      feedContext(async () => {
        fetches += 1;
        return jsonResponse(readFixture("reddit-429.json"), 429, { "retry-after": "120" });
      }),
    );
    expect(fetches).toBe(1);
    expect(result).toMatchObject({ blocked: true, status: 429 });
  });

  it("records feed_blocked and keeps the fee for a 403 and a 429", async () => {
    const forbidden = await redditThroughSenses(() => jsonResponse(readFixture("reddit-403.html"), 403, { "content-type": "text/html" }));
    expect(forbidden.fetches).toBe(1);
    expect(forbidden.output).toContain("blocked=true");
    expect(forbidden.output).toContain("status=403");
    expect(forbidden.balance).toBe(forbidden.start - forbidden.price);
    expect(forbidden.blockedEvents.some((event) => event.message.includes("source=reddit"))).toBe(true);
    expect(forbidden.feedEvents.some((event) => event.message.includes("outcome=blocked") && event.message.includes(`cost=${forbidden.price}`))).toBe(true);
    expect(forbidden.refunds).toBe(0);

    let clock = 0;
    const limited = await redditThroughSenses(
      () => jsonResponse(readFixture("reddit-429.json"), 429, { "retry-after": "0" }),
      {
        feedNow: () => clock,
        feedSleep: async (ms) => {
          clock += ms;
        },
      },
    );
    expect(limited.fetches).toBe(2);
    expect(limited.output).toContain("status=429");
    expect(limited.blockedEvents.some((event) => event.message.includes("source=reddit"))).toBe(true);
    expect(limited.balance).toBe(limited.start - limited.price);
    expect(limited.refunds).toBe(0);
  });
});

describe("bluesky auth", () => {
  it("returns unavailable when search requires auth and does not fall through", async () => {
    const calls: string[] = [];
    const result = await readBluesky(
      feedContext(async (url) => {
        calls.push(String(url));
        return jsonResponse(readFixture("bluesky-auth.json"), 401);
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("public.api.bsky.app");
    expect(result).toMatchObject({ unavailable: true, reason: "unavailable: requires auth" });
  });

  it("uses the keyless api.bsky.app search when the legacy host returns a CDN block", async () => {
    const calls: string[] = [];
    const result = await readBluesky(
      feedContext(async (url) => {
        calls.push(String(url));
        if (String(url).includes("public.api.bsky.app")) {
          return new Response("<html><title>403 Forbidden</title></html>", { status: 403, headers: { "content-type": "text/html" } });
        }
        return jsonResponse(readFixture("bluesky.json"));
      }),
    );
    expect(calls.map((url) => new URL(url).host)).toEqual(["public.api.bsky.app", "api.bsky.app"]);
    expect(result).toMatchObject({ items: [expect.objectContaining({ author: "ada.bsky.social" })] });
  });
});

async function redditThroughSenses(
  respond: () => Response,
  options: SensesServerOptions = {},
): Promise<{
  fetches: number;
  output: string;
  balance: number;
  start: number;
  price: number;
  blockedEvents: { message: string }[];
  feedEvents: { message: string }[];
  refunds: number;
}> {
  let fetches = 0;
  const senses = await startSenses({
    ...options,
    feedFetch: async () => {
      fetches += 1;
      if (fetches > 2) throw new Error("reddit retried more than once");
      return respond();
    },
  });
  cleanups.push(() => senses.close());
  const rig = harness({}, undefined, undefined, new HttpSensesClient(`http://127.0.0.1:${senses.port}`));
  cleanups.push(() => rig.cleanup());
  const created = await rig.swarm.createAgent({ name: "listener" });
  if (!created.ok) throw new Error(created.error);
  rig.swarm.ownerTopup(created.value.id, parseUsd("1"), "seed");
  const start = rig.swarm.snapshot(created.value.id).balanceUnits;
  const price = parseUsd("0.0005");
  const result = await rig.swarm.handleTool(created.value.id, {
    id: `reddit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: "read_feed",
    arguments: { source: "reddit", query: "ears", options: { subreddit: "test" } },
  });
  expect(result.ok).toBe(true);
  const output = result.ok ? (result.output ?? "") : "";
  const blockedEvents = rig.db
    .prepare("SELECT message FROM events WHERE agent_id = ? AND kind = 'feed_blocked'")
    .all(created.value.id) as { message: string }[];
  const feedEvents = rig.db
    .prepare("SELECT message FROM events WHERE agent_id = ? AND kind = 'read_feed'")
    .all(created.value.id) as { message: string }[];
  const refunds = (
    rig.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE agent_id = ? AND note = 'read_feed refund'").get(created.value.id) as {
      n: number;
    }
  ).n;
  return {
    fetches,
    output,
    balance: rig.swarm.snapshot(created.value.id).balanceUnits,
    start,
    price,
    blockedEvents,
    feedEvents,
    refunds,
  };
}

class FeedProbe implements SensesClient {
  calls = 0;
  balanceAtCall: number[] = [];
  mode: "ok" | "throw" | "refuse" | "blocked" | "unavailable" = "ok";

  constructor(private readonly balance: () => number) {}

  async see(_input: SeePageRequest): Promise<SeePageResult> {
    throw new Error("see was not stubbed");
  }

  async crawl(_input: CrawlSiteRequest): Promise<CrawlSiteResult> {
    throw new Error("crawl was not stubbed");
  }

  async feed(input: FeedRequest): Promise<FeedResult> {
    this.calls += 1;
    this.balanceAtCall.push(this.balance());
    if (this.mode === "throw") throw new Error("feed crashed");
    if (this.mode === "refuse") throw new SensesRequestError("upstream failed", 502);
    if (this.mode === "blocked") {
      return { source: input.source, items: [], blocked: true, status: 403, reason: "reddit forbidden", unavailable: false };
    }
    if (this.mode === "unavailable") {
      return { source: input.source, items: [], blocked: false, unavailable: true, reason: "unavailable: requires auth" };
    }
    return {
      source: input.source,
      items: [{ source: input.source, id: "1", title: "Ears", url: "https://example.com/ears", text: "hello feed", author: "ada", score: 1 }],
      blocked: false,
      unavailable: false,
    };
  }
}

function rigWithProbe(overrides: Record<string, string> = {}) {
  let read = () => 0;
  const probe = new FeedProbe(() => read());
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

async function funded(overrides: Record<string, string> = {}) {
  const box = rigWithProbe(overrides);
  const created = await box.rig.swarm.createAgent({ name: "listener" });
  if (!created.ok) throw new Error(created.error);
  box.rig.swarm.ownerTopup(created.value.id, parseUsd("1"), "seed");
  box.bind(created.value.id);
  return { ...box, id: created.value.id };
}

describe("read_feed ledger", () => {
  it("prices the call from the ledger env", () => {
    const { rig } = rigWithProbe();
    expect(rig.config.readFeedPriceUnits).toBe(parseUsd("0.0005"));
    expect(rig.config.readFeedHourlyLimit).toBe(60);
    expect(rig.config.toolCosts.read_feed).toBe(parseUsd("0.0005"));
    expect(rig.config.redditUserAgent).toBe(DEFAULT_REDDIT_USER_AGENT);
  });

  it("refuses an unknown source and a private rss url before charging", async () => {
    const { rig, probe, id } = await funded();
    const before = rig.swarm.snapshot(id).balanceUnits;
    const unknown = await rig.swarm.handleTool(id, { id: "feed-x", name: "read_feed", arguments: { source: "twitter", query: "cats" } });
    const rss = await rig.swarm.handleTool(id, {
      id: "feed-rss",
      name: "read_feed",
      arguments: { source: "rss", query: "http://10.0.0.1/feed.xml" },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe("unknown source");
    expect(rss.ok).toBe(false);
    if (!rss.ok) expect(rss.reason).toMatch(/private|link-local/i);
    expect(probe.calls).toBe(0);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(before);
  });

  it("debits before the call and refunds a senses error", async () => {
    const { rig, probe, id } = await funded();
    const start = rig.swarm.snapshot(id).balanceUnits;
    const price = parseUsd("0.0005");
    const ok = await rig.swarm.handleTool(id, { id: "feed-ok", name: "read_feed", arguments: { source: "hn", query: "ears" } });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.output).toContain("hello feed");
    expect(probe.balanceAtCall[0]).toBe(start - price);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - price);
    const agent = rig.db.prepare("SELECT workspace FROM agents WHERE id = ?").get(id) as { workspace: string };
    const files = fs.readdirSync(path.join(agent.workspace, "evidence"));
    expect(files[0]).toMatch(/-feed\.json$/);
    const saved = JSON.parse(fs.readFileSync(path.join(agent.workspace, "evidence", files[0] ?? ""), "utf8")) as FeedResult;
    expect(saved.items[0]?.title).toBe("Ears");

    probe.mode = "refuse";
    const refused = await rig.swarm.handleTool(id, { id: "feed-refuse", name: "read_feed", arguments: { source: "hn", query: "ears" } });
    expect(refused.ok).toBe(false);
    expect(probe.balanceAtCall[1]).toBe(start - price * 2);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - price);

    probe.mode = "throw";
    const crashed = await rig.swarm.handleTool(id, { id: "feed-crash", name: "read_feed", arguments: { source: "hn", query: "ears" } });
    expect(crashed.ok).toBe(false);
    if (!crashed.ok) expect(crashed.reason).toContain("feed crashed");
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - price);
  });

  it("keeps the fee when reddit is blocked and when bluesky requires auth", async () => {
    const { rig, probe, id } = await funded();
    const start = rig.swarm.snapshot(id).balanceUnits;
    const price = parseUsd("0.0005");
    probe.mode = "blocked";
    const blocked = await rig.swarm.handleTool(id, { id: "feed-block", name: "read_feed", arguments: { source: "reddit", query: "ears" } });
    expect(blocked.ok).toBe(true);
    if (blocked.ok) expect(blocked.output).toContain("blocked=true");
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - price);
    const events = rig.db.prepare("SELECT kind, message FROM events WHERE agent_id = ? AND kind = 'feed_blocked'").all(id) as {
      kind: string;
      message: string;
    }[];
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toContain("source=reddit");

    probe.mode = "unavailable";
    const missing = await rig.swarm.handleTool(id, { id: "feed-auth", name: "read_feed", arguments: { source: "bluesky", query: "ears" } });
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.output).toContain("unavailable: requires auth");
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - price * 2);
  });

  it("refuses the hourly limit without charging", async () => {
    const { rig, probe, id } = await funded({ READ_FEED_HOURLY_LIMIT: "2" });
    const start = rig.swarm.snapshot(id).balanceUnits;
    const price = parseUsd("0.0005");
    for (const callId of ["h1", "h2"]) {
      const seen = await rig.swarm.handleTool(id, { id: callId, name: "read_feed", arguments: { source: "hn", query: "ears" } });
      expect(seen.ok).toBe(true);
    }
    const limited = await rig.swarm.handleTool(id, { id: "h3", name: "read_feed", arguments: { source: "hn", query: "ears" } });
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.reason).toContain("hourly limit is 2");
    expect(probe.calls).toBe(2);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - price * 2);
    rig.clock.advance(3_600_000);
    const again = await rig.swarm.handleTool(id, { id: "h4", name: "read_feed", arguments: { source: "hn", query: "ears" } });
    expect(again.ok).toBe(true);
    expect(probe.calls).toBe(3);
  });
});

describe("reference files", () => {
  it("mounts /ref read-only on the agent container", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-ref-mount-"));
    const log = path.join(dir, "args.log");
    const docker = path.join(dir, "docker.cjs");
    fs.writeFileSync(
      docker,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("container-id\\n");
`,
    );
    fs.chmodSync(docker, 0o755);
    const config = loadConfig({
      DATA_DIR: dir,
      WALLET_MASTER_KEY: "test-master-key-1234",
      ADMIN_TOKEN: "test-admin",
      RUNTIME: "docker",
    });
    const runtime = new DockerRuntime(config, [docker]);
    await runtime.start({ id: "agent_1", token: "agent-token", workspace: path.join(dir, "ws") });
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const run = calls.find((args) => args[0] === "run");
    expect(run).toBeTruthy();
    expect(run).toContain("--read-only");
    expect(run).toContain("--cap-drop");
    expect(run).toContain("ALL");
    expect(run!.join(" ")).toContain(":ro");
    expect(run).toContain(`${config.refDir}:/ref:ro`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lets read_file read /ref, and refuses writes and other host paths", async () => {
    expect(getRefRoot()).toBe("/ref");
    expect(classifyAgentPath("/ref/public-apis.md")).toBe("ref");
    expect(classifyAgentPath("/etc/passwd")).toBe("deny");
    expect(classifyAgentPath("/ref/../etc/passwd")).toBe("deny");
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-ref-"));
    const file = path.join(mount, "public-apis.md");
    const link = path.join(mount, "escape.link");
    fs.writeFileSync(file, "catalog of public data");
    fs.symlinkSync("/etc/passwd", link);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-ref-read-"));
    fs.writeFileSync(path.join(workspace, "note.txt"), "local note");
    setRefRoot(mount);
    try {
      expect(getRefRoot()).toBe(mount);
      const read = await executeLocalTool({
        workspace,
        call: { id: "r1", name: "read_file", arguments: { path: file } },
        denyHosts: [],
      });
      expect(read).toBe("catalog of public data");
      const local = await executeLocalTool({
        workspace,
        call: { id: "r2", name: "read_file", arguments: { path: "note.txt" } },
        denyHosts: [],
      });
      expect(local).toBe("local note");
      const write = await executeLocalTool({
        workspace,
        call: { id: "w1", name: "write_file", arguments: { path: file, content: "mutated" } },
        denyHosts: [],
      });
      expect(write).toMatch(/read-only/i);
      expect(fs.readFileSync(file, "utf8")).toBe("catalog of public data");
      const host = await executeLocalTool({
        workspace,
        call: { id: "r3", name: "read_file", arguments: { path: "/etc/passwd" } },
        denyHosts: [],
      });
      expect(host).toMatch(/workspace/i);
      expect(host).not.toContain("root:");
      const escape = await executeLocalTool({
        workspace,
        call: { id: "r4", name: "read_file", arguments: { path: `${mount}/public-apis.md/../../../../etc/passwd` } },
        denyHosts: [],
      });
      expect(escape).not.toContain("root:");
      const viaLink = await executeLocalTool({
        workspace,
        call: { id: "r5", name: "read_file", arguments: { path: link } },
        denyHosts: [],
      });
      expect(viaLink).not.toContain("root:");

      setRefRoot("/ref");
      const { rig, id } = await funded();
      const before = rig.swarm.snapshot(id).balanceUnits;
      const allowed = await rig.swarm.handleTool(id, { id: "ref-read", name: "read_file", arguments: { path: "/ref/public-apis.md" } });
      expect(allowed.ok).toBe(true);
      if (allowed.ok) expect(allowed.handled).toBe(false);
      expect(rig.swarm.snapshot(id).balanceUnits).toBe(before - parseUsd("0.0001"));
      const deniedWrite = await rig.swarm.handleTool(id, {
        id: "ref-write",
        name: "write_file",
        arguments: { path: "/ref/public-apis.md", content: "no" },
      });
      expect(deniedWrite.ok).toBe(false);
      if (!deniedWrite.ok) expect(deniedWrite.reason).toMatch(/read-only/i);
      const deniedHost = await rig.swarm.handleTool(id, { id: "ref-host", name: "read_file", arguments: { path: "/etc/passwd" } });
      expect(deniedHost.ok).toBe(false);
      if (!deniedHost.ok) expect(deniedHost.reason).toMatch(/workspace/i);
      const deniedEscape = await rig.swarm.handleTool(id, {
        id: "ref-escape",
        name: "read_file",
        arguments: { path: "/ref/../etc/passwd" },
      });
      expect(deniedEscape.ok).toBe(false);
      expect(rig.swarm.snapshot(id).balanceUnits).toBe(before - parseUsd("0.0001"));
      expect(fs.readFileSync(file, "utf8")).toBe("catalog of public data");
    } finally {
      setRefRoot("/ref");
      fs.rmSync(mount, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
