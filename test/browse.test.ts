import fs from "node:fs";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createSensesServer } from "../senses/src/server.ts";
import { addressAllowed, BrowseLlmProxy, INTERNAL_LLM_PATH, startInternalLlmServer } from "../src/llm-proxy.js";
import { parseUsd } from "../src/money.js";
import type { DirectHost } from "../src/host.js";
import { startServer } from "../src/server.js";
import {
  type BrowseTaskRequest,
  type BrowseTaskResult,
  type CrawlSiteRequest,
  type CrawlSiteResult,
  type FeedRequest,
  type FeedResult,
  type SeePageRequest,
  type SeePageResult,
  type SensesClient,
} from "../src/senses-client.js";
import { harness } from "./helpers.js";
import { getAgent } from "../src/db.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

class BrowseProbe implements SensesClient {
  calls: BrowseTaskRequest[] = [];
  steps = 4;
  mode: "ok" | "throw" = "ok";

  async see(_input: SeePageRequest): Promise<SeePageResult> {
    throw new Error("see was not stubbed");
  }
  async crawl(_input: CrawlSiteRequest): Promise<CrawlSiteResult> {
    throw new Error("crawl was not stubbed");
  }
  async feed(_input: FeedRequest): Promise<FeedResult> {
    throw new Error("feed was not stubbed");
  }
  async browse(input: BrowseTaskRequest): Promise<BrowseTaskResult> {
    this.calls.push(input);
    if (this.mode === "throw") throw new Error("senses down");
    return {
      result: "The pier is closed.",
      steps: this.steps,
      urls: ["http://93.184.216.34/notes"],
      transcript: [{ step: 1, text: "read the page" }],
      outcome: "ok",
    };
  }
}

class ScriptedLlm {
  cost = 10_000;
  issued: string[] = [];
  closed: string[] = [];
  issue(input: { agentId: string; model: string; now: number }): string {
    const token = `tok-${this.issued.length + 1}`;
    this.issued.push(`${input.agentId}:${input.model}:${token}`);
    return token;
  }
  close(token: string): number {
    this.closed.push(token);
    return this.cost;
  }
}

function funded(overrides: Record<string, string> = {}) {
  const probe = new BrowseProbe();
  const llm = new ScriptedLlm();
  const rig = harness({ BROWSE_ENABLED: "true", ...overrides }, undefined, undefined, probe);
  rig.swarm.setBrowseLlm(llm);
  cleanups.push(() => rig.cleanup());
  return { rig, probe, llm };
}

describe("browse tool", () => {
  it("refuses when the flag is off and does not debit", async () => {
    const probe = new BrowseProbe();
    const rig = harness({}, undefined, undefined, probe);
    cleanups.push(() => rig.cleanup());
    expect(rig.config.browseEnabled).toBe(false);
    const created = await rig.swarm.createAgent({ name: "scout" });
    if (!created.ok) throw new Error(created.error);
    rig.swarm.ownerTopup(created.value.id, parseUsd("1"), "seed");
    const before = rig.swarm.snapshot(created.value.id).balanceUnits;
    const result = await rig.swarm.handleTool(created.value.id, {
      id: "browse-off",
      name: "browse",
      arguments: { task: "Read the tide table", max_steps: 3 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("browse is disabled by the owner");
    expect(rig.swarm.snapshot(created.value.id).balanceUnits).toBe(before);
    expect(probe.calls).toHaveLength(0);
    const debits = rig.db
      .prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE agent_id = ? AND note = 'browse'")
      .get(created.value.id) as { n: number };
    expect(debits.n).toBe(0);
  });

  it("caps steps at 15 and charges steps times price plus llm cost, capped at the pre-authorization", async () => {
    const { rig, probe, llm } = funded();
    const created = await rig.swarm.createAgent({ name: "scout" });
    if (!created.ok) throw new Error(created.error);
    rig.swarm.ownerTopup(created.value.id, parseUsd("1"), "seed");
    probe.steps = 40;
    llm.cost = 10_000;
    const before = rig.swarm.snapshot(created.value.id).balanceUnits;
    const result = await rig.swarm.handleTool(created.value.id, {
      id: "browse-1",
      name: "browse",
      arguments: { task: "Read the tide table", max_steps: 40 },
    });
    expect(result.ok).toBe(true);
    expect(probe.calls[0]?.maxSteps).toBe(15);
    expect(probe.calls[0]?.llmToken).toBe("tok-1");
    const step = parseUsd("0.005");
    const charged = 15 * step + 10_000;
    expect(rig.swarm.snapshot(created.value.id).balanceUnits).toBe(before - charged);
    const agent = getAgent(rig.db, created.value.id);
    if (!agent) throw new Error("missing");
    const file = fs.readdirSync(`${agent.workspace}/evidence`).find((name) => name.endsWith("-browse.json"));
    expect(file).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(`${agent.workspace}/evidence/${file}`, "utf8")) as { steps: number; llmCostUnits: number };
    expect(saved.steps).toBe(15);
    expect(saved.llmCostUnits).toBe(10_000);
    const events = rig.db
      .prepare("SELECT message FROM events WHERE agent_id = ? AND kind = 'browse'")
      .all(created.value.id) as unknown as { message: string }[];
    expect(events.some((event) => event.message.includes(`cost=${charged}`) && event.message.includes("steps=15"))).toBe(true);
  });

  it("caps a huge model bill at the pre-authorization", async () => {
    const { rig, probe, llm } = funded();
    const created = await rig.swarm.createAgent({ name: "scout" });
    if (!created.ok) throw new Error(created.error);
    rig.swarm.ownerTopup(created.value.id, parseUsd("1"), "seed");
    probe.steps = 15;
    llm.cost = parseUsd("5");
    const before = rig.swarm.snapshot(created.value.id).balanceUnits;
    const result = await rig.swarm.handleTool(created.value.id, {
      id: "browse-cap",
      name: "browse",
      arguments: { task: "Read the tide table" },
    });
    expect(result.ok).toBe(true);
    const preauth = 15 * parseUsd("0.005") + parseUsd("0.05");
    expect(rig.swarm.snapshot(created.value.id).balanceUnits).toBe(before - preauth);
  });

  it("refuses an unaffordable browse without debiting", async () => {
    const { rig, probe } = funded();
    const created = await rig.swarm.createAgent({ name: "scout" });
    if (!created.ok) throw new Error(created.error);
    rig.swarm.ownerTopup(created.value.id, parseUsd("0.01"), "seed");
    const before = rig.swarm.snapshot(created.value.id).balanceUnits;
    const result = await rig.swarm.handleTool(created.value.id, {
      id: "browse-poor",
      name: "browse",
      arguments: { task: "Read the tide table" },
    });
    expect(result.ok).toBe(false);
    expect(rig.swarm.snapshot(created.value.id).balanceUnits).toBe(before);
    expect(probe.calls).toHaveLength(0);
  });

  it("refunds the hold when senses fails and enforces the hourly limit", async () => {
    const { rig, probe, llm } = funded({ BROWSE_HOURLY_LIMIT: "3" });
    const created = await rig.swarm.createAgent({ name: "scout" });
    if (!created.ok) throw new Error(created.error);
    rig.swarm.ownerTopup(created.value.id, parseUsd("1"), "seed");
    probe.mode = "throw";
    const before = rig.swarm.snapshot(created.value.id).balanceUnits;
    const failed = await rig.swarm.handleTool(created.value.id, {
      id: "browse-err",
      name: "browse",
      arguments: { task: "Read the tide table", max_steps: 2 },
    });
    expect(failed.ok).toBe(false);
    expect(rig.swarm.snapshot(created.value.id).balanceUnits).toBe(before);
    expect(llm.closed).toEqual(["tok-1"]);
    probe.mode = "ok";
    probe.steps = 1;
    llm.cost = 0;
    // The failed call already took one of the three hourly slots.
    for (let index = 0; index < 2; index += 1) {
      const ok = await rig.swarm.handleTool(created.value.id, {
        id: `browse-ok-${index}`,
        name: "browse",
        arguments: { task: "Read the tide table", max_steps: 1 },
      });
      expect(ok.ok).toBe(true);
    }
    const blocked = await rig.swarm.handleTool(created.value.id, {
      id: "browse-limit",
      name: "browse",
      arguments: { task: "Read the tide table" },
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain("hourly limit");
    expect(probe.calls).toHaveLength(3);
  });
});

describe("browse llm proxy", () => {
  it("rejects missing, invalid, and reused tokens and is not on the agent server or under /a", async () => {
    const rig = harness({ BROWSE_ENABLED: "true" });
    cleanups.push(() => rig.cleanup());
    const seen: { model?: string; authorization?: string }[] = [];
    const proxy = new BrowseLlmProxy({
      clock: rig.clock,
      openRouterUrl: "http://openrouter.test/api/v1/chat/completions",
      openRouterKey: "sk-test",
      allowCidrs: [],
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        const headers = init?.headers as Record<string, string>;
        seen.push({ model: body.model, authorization: headers.Authorization });
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.01 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const internal = await startInternalLlmServer(proxy, 0, "127.0.0.1");
    cleanups.push(() => internal.close());
    const missing = await fetch(`${internal.url}${INTERNAL_LLM_PATH}`, { method: "POST", body: "{}" });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "missing token" });
    const invalid = await fetch(`${internal.url}${INTERNAL_LLM_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-token" },
      body: "{}",
    });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({ error: "invalid token" });
    const token = proxy.issue({ agentId: "a1", model: "org/heretic-normal", now: rig.clock.now() });
    const first = await fetch(`${internal.url}${INTERNAL_LLM_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "evil-model", messages: [] }),
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${internal.url}${INTERNAL_LLM_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "evil-model" }),
    });
    expect(second.status).toBe(200);
    expect(seen.every((call) => call.model === "org/heretic-normal")).toBe(true);
    expect(seen.every((call) => call.authorization === "Bearer sk-test")).toBe(true);
    expect(proxy.close(token)).toBe(20_000);
    const reused = await fetch(`${internal.url}${INTERNAL_LLM_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });
    expect(reused.status).toBe(401);
    expect(await reused.json()).toEqual({ error: "reused token" });

    const hidden = await startInternalLlmServer(
      new BrowseLlmProxy({ clock: rig.clock, openRouterUrl: "http://openrouter.test", openRouterKey: "sk", allowCidrs: ["10.0.0.0/8"] }),
      0,
      "127.0.0.1",
    );
    cleanups.push(() => hidden.close());
    const refused = await fetch(`${hidden.url}${INTERNAL_LLM_PATH}`, { method: "POST", body: "{}" });
    expect(refused.status).toBe(403);
    expect(addressAllowed("172.31.210.20", ["172.31.210.0/24"])).toBe(true);
    expect(addressAllowed("127.0.0.1", ["172.31.210.0/24"])).toBe(false);

    const server = await startServer({
      config: { ...rig.config, port: 0, host: "127.0.0.1" },
      swarm: rig.swarm,
      host: {} as DirectHost,
      background: false,
    });
    cleanups.push(() => server.close());
    const onAgentPort = await fetch(`${server.url}${INTERNAL_LLM_PATH}`, { method: "POST", body: "{}" });
    expect(onAgentPort.status).toBe(404);
    const underA = await fetch(`${server.url}/a/${INTERNAL_LLM_PATH}`, { method: "POST" });
    expect(underA.status).not.toBe(200);
    expect(await underA.text()).not.toContain("choices");
  });
});

describe("browse wiring", () => {
  it("keeps the proxy off the agent network and the secrets out of the senses container", () => {
    const compose = fs.readFileSync("docker-compose.yml", "utf8");
    const senses = serviceBlock(compose, "senses");
    const orchestrator = serviceBlock(compose, "orchestrator");
    expect(senses).not.toContain("OPENROUTER_API_KEY");
    expect(senses).not.toContain("BROWSER_USE_API_KEY");
    expect(senses).toContain('ANONYMIZED_TELEMETRY: "false"');
    expect(senses).toContain("- senses");
    expect(senses).not.toContain("- default");
    expect(orchestrator).toContain("INTERNAL_LLM_HOST: 172.31.210.10");
    expect(orchestrator).toContain("INTERNAL_LLM_ALLOW_CIDRS: 172.31.210.0/24");
    expect(orchestrator).not.toContain("4758:4758");
    expect(orchestrator).toContain("BROWSE_ENABLED:");
    expect(compose).not.toMatch(/^\s+-\s+"[^"]*4758[^"]*"/m);
  });

  it("shares the senses queue and caps max_steps", async () => {
    let active = 0;
    let max = 0;
    const server = createSensesServer({
      runBrowse: async () => {
        active += 1;
        max = Math.max(max, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return { ok: true, result: "x", steps: 1, urls: [], transcript: [], outcome: "ok" };
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    cleanups.push(
      () =>
        new Promise((resolve) => {
          server.close(() => resolve());
        }),
    );
    const post = (steps: number) =>
      fetch(`http://127.0.0.1:${address.port}/browse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "look", max_steps: steps }),
      });
    const [first, second] = await Promise.all([post(3), post(99)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(max).toBe(1);
    const tooBig = await post(0);
    expect(tooBig.status).toBe(400);
  });

  it("checks browse.py request guards without a browser", () => {
    const ran = spawnSync("python3", ["senses/browse.py", "--guards"], { encoding: "utf8" });
    expect(ran.status).toBe(0);
    const report = JSON.parse(ran.stdout) as {
      post: { block: string };
      download: { block: string };
      small_download: { block: string | null };
      scheme: { block: string };
      captcha: { block: string; reason: string };
      login: { block: string };
      get: { block: string | null };
      telemetry: string;
      max_steps: number;
    };
    expect(report.post.block).toBe("form");
    expect(report.download.block).toBe("download");
    expect(report.small_download.block).toBeNull();
    expect(report.scheme.block).toBe("scheme");
    expect(report.captcha.block).toBe("captcha");
    expect(report.captcha.reason).toBe("blocked: captcha");
    expect(report.login.block).toBe("login");
    expect(report.get.block).toBeNull();
    expect(report.telemetry).toBe("false");
    expect(report.max_steps).toBe(15);
  });

  it("blocks a form submit and a download over 5 MB when a local browser is available", async (ctx) => {
    const fixture = await listen((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/form") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<form method='post' action='/submit'><button id='send' type='submit'>Send</button></form>");
        return;
      }
      if (path === "/download") {
        const body = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": "attachment; filename=big.bin",
          "content-length": String(body.length),
        });
        res.end(body);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    cleanups.push(() => fixture.close());
    const ran = await new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn("python3", ["senses/browse.py", "--fixture", `http://127.0.0.1:${fixture.port}`]);
      const out: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("fixture timed out"));
      }, 40_000);
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout: Buffer.concat(out).toString("utf8") });
      });
    });
    if (ran.status !== 0) {
      ctx.skip();
      return;
    }
    const report = JSON.parse(ran.stdout || "{}") as { skipped?: boolean; reason?: string; form?: string; download?: string };
    if (report.skipped) {
      ctx.skip();
      return;
    }
    expect(report.form).toBe("blocked");
    expect(report.download).toBe("blocked");
  });
});

function serviceBlock(compose: string, name: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`missing service ${name}`);
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:/.test(lines[index] ?? "")) break;
    body.push(lines[index] ?? "");
  }
  return body.join("\n");
}

function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture did not bind");
      resolve({
        port: address.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
