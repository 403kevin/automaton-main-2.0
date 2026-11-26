import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentLoop, type AgentHost } from "../src/agent/loop.js";
import { TOOL_DEFINITIONS } from "../src/agent/tools.js";
import { loadConfig } from "../src/config.js";
import { parseUsd } from "../src/money.js";
import { buildSystemPrompt, buildWakeup } from "../src/prompt.js";
import { RULE_IDS } from "../src/refusals.js";
import { DockerRuntime } from "../src/runtime.js";
import { loadEnvFile } from "../src/soak.js";
import type { AgentSnapshot, ToolCall } from "../src/types.js";
import { harness } from "./helpers.js";

// specs/BO-4.2-feeds-ship-idle.md

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()?.();
    } catch {
      // Windows can hold the sqlite file briefly after the harness closes.
    }
  }
});

let callCounter = 0;
function call(name: string, args: Record<string, unknown>): ToolCall {
  callCounter += 1;
  return { id: `bo42-${name}-${callCounter}`, name, arguments: args };
}

function snapshot(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: "agent_1",
    name: "mite",
    status: "running",
    tier: "normal",
    model: "org/model",
    balanceUnits: parseUsd("1.00"),
    balance: "$1.00",
    genesisPrompt: "Find a customer.",
    strategyNotes: "",
    killSwitch: false,
    walletAddress: "0x1111111111111111111111111111111111111111",
    rentUnits: parseUsd("0.05"),
    graceUntil: null,
    recentTurns: [],
    ...over,
  };
}

async function funded(overrides: Record<string, string> = {}) {
  const rig = harness(overrides);
  cleanups.push(rig.cleanup);
  const made = await rig.swarm.createAgent({ name: "mite" });
  if (!made.ok) throw new Error(made.error);
  rig.swarm.ownerTopup(made.value.id, parseUsd("1.00"), "seed");
  const id = made.value.id;
  const workspace = path.join(rig.config.dataDir, "agents", id, "workspace");
  fs.mkdirSync(path.join(workspace, "job"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "job", "handler.js"), "process.stdout.write('hi');\n");
  const balance = () => rig.swarm.snapshot(id).balanceUnits;
  const run = (name: string, args: Record<string, unknown>) => rig.swarm.handleTool(id, call(name, args));
  return { rig, id, balance, run };
}

function section(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line === `## ${title}`);
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("BO-4.2 A: demand feeds and /ref cues in the prompts", () => {
  it("tells the agent to sample feeds and /ref catalogs before generic web_search", () => {
    const prompt = buildSystemPrompt(snapshot());
    for (const needle of ["read_feed", "hn", "x402-bazaar", "rss", "reddit", "/ref/public-apis.md", "/ref/datasets.rst", "/ref/SOURCES.md", "read_file"]) {
      expect(prompt, needle).toContain(needle);
    }
    expect(prompt.indexOf("read_feed")).toBeLessThan(prompt.indexOf("web_search"));
    expect(prompt.indexOf("/ref/public-apis.md")).toBeLessThan(prompt.indexOf("web_search"));
  });

  it("nudges an agent with no live endpoint to write handler.js and serve_endpoint before researching", () => {
    const wake = buildWakeup(snapshot({ liveEndpoints: 0 }));
    expect(wake).toContain("write_file");
    expect(wake).toContain("handler.js");
    expect(wake).toContain("serve_endpoint");
    expect(wake).toMatch(/before (starting )?(new |any )?research/i);
  });

  it("gives no ship-one-thing nudge to an agent that already has a live endpoint, or when the count is unknown", () => {
    expect(buildWakeup(snapshot({ liveEndpoints: 1 }))).not.toContain("handler.js");
    expect(buildWakeup(snapshot())).not.toContain("handler.js");
  });

  it("reports liveEndpoints in the swarm snapshot: 0 for a new agent, 1 after a tested endpoint is published", async () => {
    const { rig, id, run } = await funded();
    expect(rig.swarm.snapshot(id).liveEndpoints).toBe(0);
    const served = await run("serve_endpoint", { name: "echo", price_usd: "0.01", handler_dir: "job" });
    expect(served.ok).toBe(true);
    expect(rig.swarm.snapshot(id).liveEndpoints).toBe(1);
  });
});

describe("BO-4.2 A: feeds apart from page views in the daily report", () => {
  it("renders searches, feeds, page views, browse calls and cost in that order", async () => {
    const { rig, id } = await funded();
    const add = (tool: string) =>
      rig.db
        .prepare("INSERT INTO evidence (agent_id, tool, input_hash, output_hash, url, status, threat_level, flags, created_at) VALUES (?, ?, 'h', 'o', NULL, 'ok', 'none', '', ?)")
        .run(id, tool, rig.clock.now());
    add("web_search");
    add("read_feed");
    add("read_feed");
    add("see_page");
    add("crawl_site");
    add("fetch_url");
    const text = section(rig.swarm.writeDailyReport().markdown, "Senses usage");
    expect(text).toMatch(/- mite: searches 1, feeds 2, page views 3, browse calls 0, cost \$[0-9.]+/);
  });
});

describe("BO-4.2 B: ALLOW_OFFER_SERVICE gate", () => {
  it("loads ALLOW_OFFER_SERVICE as true by default, true for 'true', false for anything else", () => {
    const base = { WALLET_MASTER_KEY: "test-master-key-1234", ADMIN_TOKEN: "test-admin" };
    expect(loadConfig(base).allowOfferService).toBe(true);
    expect(loadConfig({ ...base, ALLOW_OFFER_SERVICE: "true" }).allowOfferService).toBe(true);
    expect(loadConfig({ ...base, ALLOW_OFFER_SERVICE: "false" }).allowOfferService).toBe(false);
    expect(loadConfig({ ...base, ALLOW_OFFER_SERVICE: "nope" }).allowOfferService).toBe(false);
  });

  it("refuses offer_service with tool.disabled before charging, writes a refusal row and no service", async () => {
    const { rig, id, balance, run } = await funded({ ALLOW_OFFER_SERVICE: "false" });
    const before = balance();
    const result = await run("offer_service", { priceUsd: "0.01", description: "Tide tables", body: "Low tide 06:12" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.rule).toBe("tool.disabled");
    expect(result.reason).toBe("Static offer_service is disabled; write handler.js and test-publish a paid endpoint with serve_endpoint instead.");
    expect(balance()).toBe(before);
    const rows = rig.db.prepare("SELECT rule_id, tool FROM refusals WHERE agent_id = ?").all(id) as Array<{ rule_id: string; tool: string }>;
    expect(rows).toEqual([{ rule_id: "tool.disabled", tool: "offer_service" }]);
    expect((rig.db.prepare("SELECT COUNT(*) AS n FROM services WHERE agent_id = ?").get(id) as { n: number }).n).toBe(0);
    expect(
      (rig.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE agent_id = ? AND kind = 'tool' AND amount_units < 0").get(id) as { n: number }).n,
    ).toBe(0);
  });

  it("still allows offer_service when the switch is not set (default true)", async () => {
    const { rig, id, run } = await funded();
    const result = await run("offer_service", { priceUsd: "0.01", description: "Tide tables", body: "Low tide 06:12" });
    expect(result.ok).toBe(true);
    expect((rig.db.prepare("SELECT COUNT(*) AS n FROM services WHERE agent_id = ?").get(id) as { n: number }).n).toBe(1);
  });

  it("still allows serve_endpoint when offer_service is disabled", async () => {
    const { run } = await funded({ ALLOW_OFFER_SERVICE: "false" });
    const served = await run("serve_endpoint", { name: "echo", price_usd: "0.01", handler_dir: "job" });
    expect(served.ok).toBe(true);
  });

  it("points models at serve_endpoint in the offer_service tool description", () => {
    const offer = TOOL_DEFINITIONS.find((tool) => tool.name === "offer_service");
    expect(offer?.description).toContain("serve_endpoint");
    expect(offer?.description).toMatch(/static|untested/i);
  });
});

describe("BO-4.2 B: phantom offers count static services", () => {
  const phantomLine = (markdown: string) => section(markdown, "Runtime observed").split("\n").find((line) => line.startsWith("- phantom offers"));

  it("counts a services row with no passing _service test delivery", async () => {
    const { rig, run } = await funded();
    await run("offer_service", { priceUsd: "0.01", description: "Tide tables", body: "Low tide 06:12" });
    expect(phantomLine(rig.swarm.writeDailyReport().markdown)).toBe("- phantom offers published (target 0): 1: fail");
  });

  it("counts a static service on top of a passing endpoint, and leaves a passing endpoint alone", async () => {
    const { rig, run } = await funded();
    expect((await run("serve_endpoint", { name: "echo", price_usd: "0.01", handler_dir: "job" })).ok).toBe(true);
    expect(phantomLine(rig.swarm.writeDailyReport().markdown)).toBe("- phantom offers published (target 0): 0: pass");
    await run("offer_service", { priceUsd: "0.01", description: "Tide tables", body: "Low tide 06:12" });
    expect(phantomLine(rig.swarm.writeDailyReport().markdown)).toBe("- phantom offers published (target 0): 1: fail");
  });

  it("does not count a services row that has a passing _service test delivery fact", async () => {
    const { rig, id, run } = await funded();
    await run("offer_service", { priceUsd: "0.01", description: "Tide tables", body: "Low tide 06:12" });
    rig.db
      .prepare("INSERT INTO facts (agent_id, kind, subject, value, source, created_at) VALUES (?, 'test_delivery', '_service', 'code=ok bytes=5', 'test', ?)")
      .run(id, rig.clock.now());
    expect(phantomLine(rig.swarm.writeDailyReport().markdown)).toBe("- phantom offers published (target 0): 0: pass");
  });
});

describe("BO-4.2 C: REPEAT_SEARCH_COOLDOWN_MS", () => {
  const COOLDOWN = String(3_600_000);

  it("loads REPEAT_SEARCH_COOLDOWN_MS (default 0) and declares the rule id", () => {
    const base = { WALLET_MASTER_KEY: "test-master-key-1234", ADMIN_TOKEN: "test-admin" };
    expect(loadConfig(base).repeatSearchCooldownMs).toBe(0);
    expect(loadConfig({ ...base, REPEAT_SEARCH_COOLDOWN_MS: "21600000" }).repeatSearchCooldownMs).toBe(21_600_000);
    expect(() => loadConfig({ ...base, REPEAT_SEARCH_COOLDOWN_MS: "-1" })).toThrow(/REPEAT_SEARCH_COOLDOWN_MS/);
    expect(RULE_IDS).toContain("limit.repeat_search");
  });

  it("refuses a normalized duplicate web_search before charging, with limit.repeat_search", async () => {
    const { rig, id, balance, run } = await funded({ REPEAT_SEARCH_COOLDOWN_MS: COOLDOWN });
    const first = await run("web_search", { query: "Tide Tables" });
    expect(first.ok).toBe(true);
    const afterFirst = balance();
    expect(afterFirst).toBeLessThan(parseUsd("1.00"));
    rig.clock.advance(1_000);
    const again = await run("web_search", { query: "  tide   TABLES  " });
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("expected refusal");
    expect(again.rule).toBe("limit.repeat_search");
    expect(again.reason).toContain("read_feed");
    expect(again.reason).toContain("/ref");
    expect(again.reason).toContain("serve_endpoint");
    expect(balance()).toBe(afterFirst);
    const rows = rig.db.prepare("SELECT rule_id FROM refusals WHERE agent_id = ? AND tool = 'web_search'").all(id) as Array<{ rule_id: string }>;
    expect(rows).toEqual([{ rule_id: "limit.repeat_search" }]);
  });

  it("allows a distinct query, and charges for it", async () => {
    const { balance, run } = await funded({ REPEAT_SEARCH_COOLDOWN_MS: COOLDOWN });
    expect((await run("web_search", { query: "tide tables" })).ok).toBe(true);
    const afterFirst = balance();
    expect((await run("web_search", { query: "harbor chart prices" })).ok).toBe(true);
    expect(balance()).toBeLessThan(afterFirst);
  });

  it("allows the same query again once the cooldown has passed", async () => {
    const { rig, run } = await funded({ REPEAT_SEARCH_COOLDOWN_MS: COOLDOWN });
    expect((await run("web_search", { query: "tide tables" })).ok).toBe(true);
    rig.clock.advance(3_600_001);
    expect((await run("web_search", { query: "tide tables" })).ok).toBe(true);
  });

  it("allows the same query again after the agent shipped an endpoint since the first search", async () => {
    const { rig, run } = await funded({ REPEAT_SEARCH_COOLDOWN_MS: COOLDOWN });
    expect((await run("web_search", { query: "tide tables" })).ok).toBe(true);
    rig.clock.advance(1_000);
    expect((await run("serve_endpoint", { name: "echo", price_usd: "0.01", handler_dir: "job" })).ok).toBe(true);
    rig.clock.advance(1_000);
    expect((await run("web_search", { query: "tide tables" })).ok).toBe(true);
  });

  it("does nothing when the cooldown is 0 (the default): the same query repeats freely", async () => {
    const { run } = await funded();
    expect((await run("web_search", { query: "tide tables" })).ok).toBe(true);
    expect((await run("web_search", { query: "tide tables" })).ok).toBe(true);
  });

  it("keeps one agent's searches from blocking another's", async () => {
    const { rig, run } = await funded({ REPEAT_SEARCH_COOLDOWN_MS: COOLDOWN });
    expect((await run("web_search", { query: "tide tables" })).ok).toBe(true);
    const other = await rig.swarm.createAgent({ name: "keel" });
    if (!other.ok) throw new Error(other.error);
    rig.swarm.ownerTopup(other.value.id, parseUsd("1.00"), "seed");
    const result = await rig.swarm.handleTool(other.value.id, call("web_search", { query: "tide tables" }));
    expect(result.ok).toBe(true);
  });
});

describe("BO-4.2 C: IDLE_BRAKE_TURNS config and Docker forwarding", () => {
  it("loads IDLE_BRAKE_TURNS (default 0, integer 0 or more)", () => {
    const base = { WALLET_MASTER_KEY: "test-master-key-1234", ADMIN_TOKEN: "test-admin" };
    expect(loadConfig(base).idleBrakeTurns).toBe(0);
    expect(loadConfig({ ...base, IDLE_BRAKE_TURNS: "3" }).idleBrakeTurns).toBe(3);
    expect(() => loadConfig({ ...base, IDLE_BRAKE_TURNS: "-1" })).toThrow(/IDLE_BRAKE_TURNS/);
  });

  async function dockerArgs(env: Record<string, string>): Promise<string[]> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-docker-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
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
    expect(spawnSync(process.execPath, [docker, "version"], { encoding: "utf8" }).status).toBe(0);
    const config = loadConfig({ DATA_DIR: dir, WALLET_MASTER_KEY: "test-master-key-1234", ADMIN_TOKEN: "test-admin", RUNTIME: "docker", ...env });
    const runtime = new DockerRuntime(config, [process.execPath, docker]);
    await runtime.start({ id: "agent_1", token: "agent-token", workspace: path.join(dir, "ws") });
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const run = calls.find((args) => args[0] === "run");
    if (!run) throw new Error("no docker run call");
    return run;
  }

  it("forwards IDLE_BRAKE_TURNS into the agent container as its own -e flag", async () => {
    const run = await dockerArgs({ IDLE_BRAKE_TURNS: "3" });
    const at = run.indexOf("IDLE_BRAKE_TURNS=3");
    expect(at).toBeGreaterThan(0);
    expect(run[at - 1]).toBe("-e");
  });

  it("forwards 0 when the brake is off", async () => {
    expect(await dockerArgs({})).toContain("IDLE_BRAKE_TURNS=0");
  });
});

describe("BO-4.2 C: idle brake in runAgentLoop", () => {
  const SLEEP = 100;

  /** One scripted turn: tool calls to return, or a skipped inference. `refuse` names tools the orchestrator refuses. */
  type Turn = { calls: ToolCall[]; refuse?: string[] } | { skip: true; retryAfterMs?: number };

  async function drive(turns: Turn[], idleBrakeTurns: number | undefined): Promise<number[]> {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-idle-"));
    cleanups.push(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const controller = new AbortController();
    const waits: number[] = [];
    let turn = 0;
    const host: AgentHost = {
      snapshot: async () => snapshot(),
      infer: async () => {
        const planned = turns[turn];
        turn += 1;
        if (turn >= turns.length) controller.abort();
        if (!planned) return { skipped: true, reason: "script over" };
        if ("skip" in planned) return { skipped: true, reason: "capped", retryAfterMs: planned.retryAfterMs };
        return { skipped: false, content: "", toolCalls: planned.calls, model: "org/model", costUnits: 0 };
      },
      authorizeTool: async (_id, toolCall) => {
        const current = turns[turn - 1];
        if (current && "calls" in current && current.refuse?.includes(toolCall.name)) return { ok: false, reason: "refused for test" };
        const orchestrated = ["serve_endpoint", "publish_page", "read_feed", "web_search"].includes(toolCall.name);
        return { ok: true, handled: orchestrated, output: "ok" };
      },
      recordTurn: async () => undefined,
      recordRefusal: async () => undefined,
    };
    await runAgentLoop({
      agentId: "agent_1",
      host,
      signal: controller.signal,
      workspace,
      denyHosts: [],
      sleepMs: SLEEP,
      idleBrakeTurns,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    });
    return waits;
  }

  const think = (): Turn => ({ calls: [] });
  const search = (): Turn => ({ calls: [call("web_search", { query: "x" })] });
  const write = (): Turn => ({ calls: [call("write_file", { path: "note.txt", content: "hi" })] });
  const serve = (): Turn => ({ calls: [call("serve_endpoint", { name: "echo", price_usd: "0.01", handler_dir: "job" })] });
  const feed = (): Turn => ({ calls: [call("read_feed", { source: "hn", query: "top" })] });

  it("waits the normal interval for the first turns, then doubles per idle turn up to 8 x the interval", async () => {
    const waits = await drive([think(), search(), think(), think(), search(), think()], 3);
    expect(waits).toEqual([SLEEP, SLEEP, 2 * SLEEP, 4 * SLEEP, 8 * SLEEP, 8 * SLEEP]);
  });

  it("resets to the normal wait after write_file", async () => {
    expect(await drive([think(), think(), write(), think(), think()], 2)).toEqual([SLEEP, 2 * SLEEP, SLEEP, SLEEP, 2 * SLEEP]);
  });

  it("resets after serve_endpoint and after read_feed", async () => {
    expect(await drive([think(), think(), serve(), think(), think(), feed(), think()], 2)).toEqual([SLEEP, 2 * SLEEP, SLEEP, SLEEP, 2 * SLEEP, SLEEP, SLEEP]);
  });

  it("does not count a refused productive call as productive", async () => {
    const waits = await drive([{ calls: [call("serve_endpoint", { name: "echo", price_usd: "0.01", handler_dir: "job" })], refuse: ["serve_endpoint"] }], 1);
    expect(waits).toEqual([2 * SLEEP]);
  });

  it("leaves the streak alone on a skipped inference, and lets a spend-cap retryAfterMs win over the brake", async () => {
    expect(await drive([think(), { skip: true }, think()], 2)).toEqual([SLEEP, SLEEP, 2 * SLEEP]);
    expect(await drive([think(), { skip: true, retryAfterMs: 5_000 }], 1)).toEqual([2 * SLEEP, 5_000]);
  });

  it("is off when IDLE_BRAKE_TURNS is 0 or not given", async () => {
    expect(await drive([think(), think(), think(), think()], 0)).toEqual([SLEEP, SLEEP, SLEEP, SLEEP]);
    expect(await drive([think(), think(), think(), think()], undefined)).toEqual([SLEEP, SLEEP, SLEEP, SLEEP]);
  });
});

describe("BO-4.2: env files carry the new settings", () => {
  it("sets the soak values in both profiles and the off values in .env.example", () => {
    for (const file of ["config/soak.env.template", "config/soak.sepolia.env"]) {
      const env = loadEnvFile(file);
      expect(env.ALLOW_OFFER_SERVICE, file).toBe("false");
      expect(env.REPEAT_SEARCH_COOLDOWN_MS, file).toBe("21600000");
      expect(env.IDLE_BRAKE_TURNS, file).toBe("3");
    }
    const example = loadEnvFile(".env.example");
    expect(example.ALLOW_OFFER_SERVICE).toBe("false");
    expect(example.REPEAT_SEARCH_COOLDOWN_MS).toBe("0");
    expect(example.IDLE_BRAKE_TURNS).toBe("0");
  });
});
