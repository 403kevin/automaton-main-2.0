import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentLoop, type AgentHost } from "../src/agent/loop.js";
import { buildCompletionBody } from "../src/actions.js";
import { loadConfig } from "../src/config.js";
import type { HandlerSandbox } from "../src/handlers.js";
import { DirectHost } from "../src/host.js";
import { InferenceGateway } from "../src/inference.js";
import { OpenRouterLlm, type LlmClient, type LlmCompletion, type ModelCatalog } from "../src/llm.js";
import type { ModelContextCache } from "../src/model-context.js";
import { modelReliabilityLines } from "../src/model-report.js";
import { parseUsd } from "../src/money.js";
import { DockerRuntime } from "../src/runtime.js";
import { parseSoakAgentModels } from "../src/seed.js";
import { startServer } from "../src/server.js";
import { loadEnvFile } from "../src/soak.js";
import { checkSpend } from "../src/spend.js";
import type { ChatMessage } from "../src/types.js";
import { harness } from "./helpers.js";

// specs/BO-4.1-pacing-truncation-models.md

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

describe("BO-4.1 hourly pacing", () => {
  it("loads AGENT_HOURLY_CAP_USD (default 0) and refuses when the hourly cap would be exceeded", () => {
    const off = loadConfig({
      WALLET_MASTER_KEY: "test-master-key-1234",
      ADMIN_TOKEN: "test-admin",
    });
    expect(off.agentHourlyCapUnits).toBe(0);

    const on = loadConfig({
      WALLET_MASTER_KEY: "test-master-key-1234",
      ADMIN_TOKEN: "test-admin",
      AGENT_HOURLY_CAP_USD: "0.04",
    });
    expect(on.agentHourlyCapUnits).toBe(parseUsd("0.04"));

    const blocked = checkSpend({
      amount: parseUsd("0.01"),
      balance: parseUsd("1.00"),
      agentSpent: 0,
      globalSpent: 0,
      agentCap: parseUsd("0.25"),
      globalCap: parseUsd("0.60"),
      killSwitch: false,
      allowNegative: false,
      agentHourlySpent: parseUsd("0.04"),
      agentHourlyCap: parseUsd("0.04"),
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/hour/i);
    expect(blocked.rule === "spend.cap.hourly" || blocked.rule === "spend.cap").toBe(true);

    const open = checkSpend({
      amount: parseUsd("0.01"),
      balance: parseUsd("1.00"),
      agentSpent: 0,
      globalSpent: 0,
      agentCap: parseUsd("0.25"),
      globalCap: parseUsd("0.60"),
      killSwitch: false,
      allowNegative: false,
      agentHourlySpent: 0,
      agentHourlyCap: 0,
    });
    expect(open.ok).toBe(true);
  });

  it("blocks discretionary spend for the rest of the UTC hour through authorize", async () => {
    const rig = harness({ AGENT_HOURLY_CAP_USD: "0.04", AGENT_DAILY_CAP_USD: "0.25", INFERENCE_RESERVE_USD: "0.01" });
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "pace" });
    if (!agent.ok) throw new Error(agent.error);
    rig.swarm.ownerTopup(agent.value.id, parseUsd("1.00"), "seed");
    expect(rig.swarm.debit(agent.value.id, parseUsd("0.04"), "inference", "h1", "model").ok).toBe(true);
    const denied = rig.swarm.authorize(agent.value.id, parseUsd("0.01"), "inference");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toMatch(/hour/i);
  });
});

describe("BO-4.1 cap sleep retryAfterMs", () => {
  it("returns retryAfterMs on a spend-cap skip so the loop can sleep until the next window", async () => {
    const rig = harness({ AGENT_HOURLY_CAP_USD: "0.04", AGENT_DAILY_CAP_USD: "0.25", INFERENCE_RESERVE_USD: "0.01" });
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "sleeper" });
    if (!agent.ok) throw new Error(agent.error);
    rig.swarm.ownerTopup(agent.value.id, parseUsd("1.00"), "seed");
    expect(rig.swarm.debit(agent.value.id, parseUsd("0.04"), "inference", "burn", "model").ok).toBe(true);

    const llm: LlmClient = {
      async complete(): Promise<LlmCompletion> {
        throw new Error("LLM must not be called when capped");
      },
    };
    const gateway = new InferenceGateway(rig.swarm, llm, rig.config);
    const skipped = await gateway.complete(agent.value.id, [{ role: "user", content: "hi" }], []);
    expect(skipped.skipped).toBe(true);
    if (!skipped.skipped) throw new Error("expected skip");
    expect(typeof skipped.retryAfterMs).toBe("number");
    expect(skipped.retryAfterMs!).toBeGreaterThan(0);
    expect(skipped.retryAfterMs!).toBeLessThanOrEqual(3_600_000);

    // Daily-cap skip uses midnight window (retryAfterMs up to 24h).
    const daily = harness({ AGENT_DAILY_CAP_USD: "0.05", INFERENCE_RESERVE_USD: "0.02" });
    cleanups.push(daily.cleanup);
    const other = await daily.swarm.createAgent({ name: "daycap" });
    if (!other.ok) throw new Error(other.error);
    daily.swarm.ownerTopup(other.value.id, parseUsd("1.00"), "seed");
    expect(daily.swarm.debit(other.value.id, parseUsd("0.05"), "inference", "full", "model").ok).toBe(true);
    const dayGateway = new InferenceGateway(daily.swarm, llm, daily.config);
    const daySkip = await dayGateway.complete(other.value.id, [{ role: "user", content: "hi" }], []);
    expect(daySkip.skipped).toBe(true);
    if (!daySkip.skipped) throw new Error("expected daily skip");
    expect(typeof daySkip.retryAfterMs).toBe("number");
    expect(daySkip.retryAfterMs!).toBeGreaterThan(0);
    expect(daySkip.retryAfterMs!).toBeLessThanOrEqual(86_400_000);
  });
});

describe("BO-4.1 Docker TURN_INTERVAL_MS", () => {
  it("passes TURN_INTERVAL_MS into the agent container env", async () => {
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
    const probe = spawnSync(process.execPath, [docker, "version"], { encoding: "utf8" });
    expect(probe.status).toBe(0);

    const config = loadConfig({
      DATA_DIR: dir,
      WALLET_MASTER_KEY: "test-master-key-1234",
      ADMIN_TOKEN: "test-admin",
      RUNTIME: "docker",
      TURN_INTERVAL_MS: "300000",
    });
    const runtime = new DockerRuntime(config, [process.execPath, docker]);
    await runtime.start({ id: "agent_1", token: "agent-token", workspace: path.join(dir, "ws") });
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const run = calls.find((args) => args[0] === "run");
    expect(run).toBeTruthy();
    expect(run).toContain("TURN_INTERVAL_MS=300000");
  });
});

describe("BO-4.1 max_tokens and finish_reason length", () => {
  it("uses MAX_OUTPUT_TOKENS (default 1500, min 256) in completion bodies", () => {
    const config = loadConfig({
      WALLET_MASTER_KEY: "test-master-key-1234",
      ADMIN_TOKEN: "test-admin",
    });
    expect(config.maxOutputTokens).toBe(1500);

    const planned = buildCompletionBody({
      model: "org/test",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "balance", description: "", parameters: {} } }],
      supported: ["tools"],
      maxTokens: config.maxOutputTokens,
    });
    expect(planned.body.max_tokens).toBe(1500);

    expect(() =>
      loadConfig({
        WALLET_MASTER_KEY: "test-master-key-1234",
        ADMIN_TOKEN: "test-admin",
        MAX_OUTPUT_TOKENS: "100",
      }),
    ).toThrow(/MAX_OUTPUT_TOKENS/);
  });

  it("does not execute truncated JSON actions and records inference_truncated", async () => {
    const rig = harness({
      LLM_MODE: "openrouter",
      OPENROUTER_API_KEY: "test-key-0000",
      MAX_OUTPUT_TOKENS: "1500",
      DEFAULT_MODEL: "org/json-model",
      ALLOWED_MODELS: "org/json-model",
    });
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "cut" });
    if (!agent.ok) throw new Error(agent.error);
    rig.swarm.ownerTopup(agent.value.id, parseUsd("1.00"), "seed");

    // Intentionally cut mid-JSON to simulate finish_reason=length.
    const truncated = ["{", '"say":"I am an AI looking for work.",', '"actions":[{"name":"web_search","arguments":{"query":"paid'].join("");
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      expect(body.max_tokens).toBe(1500);
      return new Response(
        JSON.stringify({
          model: "org/json-model",
          choices: [{ message: { content: truncated }, finish_reason: "length" }],
          usage: { prompt_tokens: 10, completion_tokens: 50, cost: 0.0001 },
        }),
        { status: 200 },
      );
    };
    const catalog = { supportedParameters: async () => ["response_format", "max_tokens"] } as unknown as ModelCatalog;
    const contexts = { contextLength: async () => 1_000_000 } as unknown as ModelContextCache;
    const llm = new OpenRouterLlm(rig.config, { fetch: fetchImpl, catalog, contexts, sleep: async () => undefined });
    const gateway = new InferenceGateway(rig.swarm, llm, rig.config);
    const result = await gateway.complete(agent.value.id, [{ role: "user", content: "go" }] as ChatMessage[], [
      { type: "function", function: { name: "web_search", description: "search", parameters: { type: "object", properties: {} } } },
    ]);
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("expected completion");
    expect(result.toolCalls).toEqual([]);

    const events = rig.db
      .prepare("SELECT kind FROM events WHERE agent_id = ? AND kind = 'inference_truncated'")
      .all(agent.value.id) as Array<{ kind: string }>;
    expect(events.length).toBeGreaterThanOrEqual(1);

    const lines = modelReliabilityLines(rig.db, 0, new Map(), []);
    expect(lines.join("\n")).toMatch(/Truncated \(length\):\s*[1-9]/);
  });
});

describe("BO-4.1 Stage 4 soak models", () => {
  it("parses SOAK_AGENT_MODELS for mite, keel, and wick", () => {
    const models = parseSoakAgentModels(
      "mite=deepseek/deepseek-v4.1-flash,keel=z-ai/glm-5.3-flash,wick=openai/gpt-6-luna",
    );
    expect(models).toEqual({
      mite: "deepseek/deepseek-v4.1-flash",
      keel: "z-ai/glm-5.3-flash",
      wick: "openai/gpt-6-luna",
    });
  });

  it("keeps soak profiles identical except MONEY_MODE and sets Stage 4 models", () => {
    const template = loadEnvFile("config/soak.env.template");
    const sepolia = loadEnvFile("config/soak.sepolia.env");
    const keys = Object.keys(template).sort();
    expect(Object.keys(sepolia).sort()).toEqual(keys);
    for (const key of keys) {
      if (key === "MONEY_MODE") continue;
      expect(sepolia[key]).toBe(template[key]);
    }
    expect(template.DEFAULT_MODEL).toBe("deepseek/deepseek-v4.1-flash");
    expect(template.AGENT_HOURLY_CAP_USD).toBe("0.04");
    expect(template.MAX_OUTPUT_TOKENS).toBe("1500");
    expect(template.AGENT_DAILY_CAP_USD).toBe("0.25");
    expect(template.GLOBAL_DAILY_CAP_USD).toBe("0.60");
    expect(template.TURN_INTERVAL_MS).toBe("300000");
    expect(template.SOAK_AGENT_MODELS).toContain("mite=");
    expect(template.SOAK_AGENT_MODELS).toContain("keel=");
    expect(template.SOAK_AGENT_MODELS).toContain("wick=");
    expect(template.FALLBACK_MODELS).not.toMatch(/:free\b/);
    expect(template.ALLOWED_MODELS).not.toMatch(/:free\b/);
  });
});

describe("BO-4.1 ops scripts", () => {
  it("documents a quoted local-dir in pull-reports usage", () => {
    const text = fs.readFileSync("scripts/pull-reports.sh", "utf8");
    expect(text).toMatch(/"<local-dir>"/);
    expect(text).toMatch(/pull-reports\.sh.*"<local-dir>"|Usage:.*"<local-dir>"/);
  });

  it("supports --read-only in preflight without requiring check 5", () => {
    const text = fs.readFileSync("scripts/preflight.sh", "utf8");
    expect(text).toMatch(/--read-only/);
    expect(text).toMatch(/check_kill|5-kill-switch/);
    expect(text).toMatch(/archive|cleanup note|preflight-probe/i);
  });
});

describe("BO-4.1 runAgentLoop honors retryAfterMs", () => {
  it("sleeps retryAfterMs, not sleepMs, after a spend-cap skip", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "looper" });
    if (!agent.ok) throw new Error(agent.error);
    const controller = new AbortController();
    const inferAt: number[] = [];
    const host: AgentHost = {
      snapshot: async (agentId) => rig.swarm.snapshot(agentId),
      infer: async () => {
        inferAt.push(Date.now());
        if (inferAt.length >= 2) controller.abort();
        return { skipped: true, reason: "Hourly cap reached.", retryAfterMs: 300 };
      },
      authorizeTool: async () => ({ ok: true, handled: false }),
      recordTurn: async () => undefined,
      recordRefusal: async () => undefined,
    };
    // sleepMs is 60s. If the loop ignored retryAfterMs the second infer would not happen inside the test timeout.
    await runAgentLoop({ agentId: agent.value.id, host, signal: controller.signal, workspace: agent.value.workspace ?? ".", denyHosts: [], sleepMs: 60_000 });
    expect(inferAt).toHaveLength(2);
    const gap = inferAt[1]! - inferAt[0]!;
    expect(gap).toBeGreaterThanOrEqual(250);
    expect(gap).toBeLessThan(5_000);
  }, 10_000);

  it("abort cuts a long cap sleep short instead of waiting out retryAfterMs", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "looper2" });
    if (!agent.ok) throw new Error(agent.error);
    const controller = new AbortController();
    let calls = 0;
    const host: AgentHost = {
      snapshot: async (agentId) => rig.swarm.snapshot(agentId),
      infer: async () => {
        calls += 1;
        setTimeout(() => controller.abort(), 100);
        return { skipped: true, reason: "Hourly cap reached.", retryAfterMs: 3_600_000 };
      },
      authorizeTool: async () => ({ ok: true, handled: false }),
      recordTurn: async () => undefined,
      recordRefusal: async () => undefined,
    };
    const started = Date.now();
    await runAgentLoop({ agentId: agent.value.id, host, signal: controller.signal, workspace: ".", denyHosts: [], sleepMs: 10 });
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
});

describe("BO-4.1 POST /admin/archive", () => {
  async function serve() {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const server = await startServer({
      config: { ...rig.config, port: 0, host: "127.0.0.1" },
      swarm: rig.swarm,
      host: new DirectHost(rig.swarm, {} as InferenceGateway),
      handlers: { shutdown: async () => undefined } as unknown as HandlerSandbox,
      background: false,
    });
    cleanups.push(() => server.close());
    return { rig, server };
  }

  function post(url: string, body: unknown, token?: string) {
    return fetch(`${url}/admin/archive`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === undefined ? {} : { "x-admin-token": token }) },
      body: JSON.stringify(body),
    });
  }

  it("rejects a missing or wrong X-Admin-Token with 401 and archives nothing", async () => {
    const { rig, server } = await serve();
    const agent = await rig.swarm.createAgent({ name: "guarded" });
    if (!agent.ok) throw new Error(agent.error);
    const none = await post(server.url, { agentId: agent.value.id });
    expect(none.status).toBe(401);
    const wrong = await post(server.url, { agentId: agent.value.id }, "not-the-token");
    expect(wrong.status).toBe(401);
    const row = rig.db.prepare("SELECT status FROM agents WHERE id = ?").get(agent.value.id) as { status: string };
    expect(row.status).not.toBe("archived");
  });

  it("rejects a bad agentId with 400", async () => {
    const { server } = await serve();
    for (const agentId of ["", "nope", "../etc/passwd", "a123", `a${"g".repeat(16)}`]) {
      const res = await post(server.url, { agentId }, "test-admin");
      expect(res.status).toBe(400);
    }
    const missing = await post(server.url, {}, "test-admin");
    expect(missing.status).toBe(400);
  });

  it("returns 200, marks the agent archived, and deletes no rows", async () => {
    const { rig, server } = await serve();
    const agent = await rig.swarm.createAgent({ name: "retire" });
    if (!agent.ok) throw new Error(agent.error);
    const id = agent.value.id;
    rig.swarm.ownerTopup(id, parseUsd("1.00"), "seed");
    expect(rig.swarm.debit(id, parseUsd("0.01"), "inference", "spent", "model").ok).toBe(true);
    const count = (table: string) => (rig.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE agent_id = ?`).get(id) as { n: number }).n;
    const ledgerBefore = count("ledger_entries");
    const eventsBefore = count("events");
    expect(ledgerBefore).toBeGreaterThan(0);

    const res = await post(server.url, { agentId: id, reason: "test archive" }, "test-admin");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, agentId: id });

    const row = rig.db.prepare("SELECT status, archived_at FROM agents WHERE id = ?").get(id) as { status: string; archived_at: number | null };
    expect(row.status).toBe("archived");
    expect(row.archived_at).not.toBeNull();
    expect(count("ledger_entries")).toBeGreaterThanOrEqual(ledgerBefore);
    expect(count("events")).toBeGreaterThanOrEqual(eventsBefore);
    expect((rig.db.prepare("SELECT COUNT(*) AS n FROM agents WHERE id = ?").get(id) as { n: number }).n).toBe(1);
  });
});
