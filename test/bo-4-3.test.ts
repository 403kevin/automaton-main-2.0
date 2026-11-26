import fs from "node:fs";
import net from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { insertFact } from "../src/claims.js";
import { loadConfig } from "../src/config.js";
import { getAgent } from "../src/db.js";
import type { HandlerSandbox } from "../src/handlers.js";
import type { DirectHost } from "../src/host.js";
import { parseUsd } from "../src/money.js";
import { insertRefusal, RULE_IDS, type RuleId } from "../src/refusals.js";
import { startServer } from "../src/server.js";
import { loadEnvFile } from "../src/soak.js";
import type { ToolCall } from "../src/types.js";
import { X402_HEADERS } from "../src/x402.js";
import { harness } from "./helpers.js";

// specs/BO-4.3-honesty-public-a.md

const RULE = "claim.contradicts_facts";
const OUTSIDE = "0x2222222222222222222222222222222222222222";
const FUNDER = "0x8888888888888888888888888888888888888888";
const HOUR = 3_600_000;
const DAY = 86_400_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()?.();
    } catch {
      // A temp directory Windows still holds is disposable.
    }
  }
});

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `${name}-${Math.random().toString(16).slice(2, 8)}`, name, arguments: args };
}

function count(box: { db: DatabaseSync }, sql: string, ...params: Array<string | number>): number {
  return (box.db.prepare(sql).get(...params) as { n: number }).n;
}

async function rig(overrides: Record<string, string> = {}) {
  const box = harness(overrides);
  cleanups.push(() => box.cleanup());
  const created = await box.swarm.createAgent({ name: "scout" });
  if (!created.ok) throw new Error(created.error);
  box.swarm.ownerTopup(created.value.id, parseUsd("1.00"), "seed-scout");
  return { ...box, id: created.value.id, address: created.value.address };
}

type Rig = Awaited<ReturnType<typeof rig>>;

async function sibling(box: Rig, name = "mate") {
  const created = await box.swarm.createAgent({ name });
  if (!created.ok) throw new Error(created.error);
  box.swarm.ownerTopup(created.value.id, parseUsd("1.00"), `seed-${name}`);
  return created.value;
}

function claim(box: Rig, statement: string, ids: unknown[] = []) {
  return box.swarm.handleTool(box.id, call("claim", { statement, evidence_ids: ids }));
}

function balance(box: Rig, id = box.id): number {
  return box.swarm.snapshot(id).balanceUnits;
}

function storedClaims(box: Rig): number {
  return count(box, "SELECT COUNT(*) AS n FROM claims WHERE agent_id = ?", box.id);
}

function refusalRows(box: Rig, rule: string): number {
  return count(box, "SELECT COUNT(*) AS n FROM refusals WHERE agent_id = ? AND rule_id = ? AND tool = 'claim' AND source = 'runtime'", box.id, rule);
}

function rejectedEvents(box: Rig): number {
  return count(box, "SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND kind = 'claim_rejected'", box.id);
}

function addEndpoint(box: Rig, name: string, status: string | null = "live", id = box.id): void {
  box.db
    .prepare("INSERT INTO endpoints (agent_id, name, price_units, snapshot_hash, updated_at, status) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, name, 10_000, `hash-${name}`, box.clock.now(), status);
}

function addDelivery(box: Rig, name: string, value: string, id = box.id): void {
  insertFact(box.db, { agentId: id, kind: "test_delivery", subject: name, value, source: `endpoint:${id}/${name}`, now: box.clock.now() });
}

async function expectContradicted(box: Rig, statement: string): Promise<void> {
  const before = balance(box);
  const stored = storedClaims(box);
  const rows = refusalRows(box, RULE);
  const events = rejectedEvents(box);
  const result = await claim(box, statement);
  expect(result.ok, statement).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  expect(result.rule, statement).toBe(RULE);
  expect(result.reason.length, statement).toBeGreaterThan(10);
  expect(refusalRows(box, RULE), statement).toBe(rows + 1);
  expect(rejectedEvents(box), statement).toBe(events + 1);
  expect(storedClaims(box), statement).toBe(stored);
  expect(balance(box), statement).toBe(before);
}

async function expectAccepted(box: Rig, statement: string): Promise<void> {
  const before = balance(box);
  const result = await claim(box, statement);
  expect(result.ok, statement).toBe(true);
  expect(before - balance(box), statement).toBe(box.config.toolCosts.claim);
}

describe("claim honesty: money", () => {
  it("lists the new rule in the closed rule list, before unclassified", () => {
    expect(RULE_IDS).toContain(RULE);
    expect(RULE_IDS.at(-1)).toBe("unclassified");
  });

  it("refuses earned, received and paid statements while the ledger holds no earned income", async () => {
    const box = await rig();
    await expectContradicted(box, "I earned $0.01.");
    await expectContradicted(box, "I received a payment.");
    await expectContradicted(box, "I was paid $0.50 by a buyer.");
    await expectContradicted(box, "A customer paid me yesterday");
  });

  it("does not count an owner top-up or a spend as income", async () => {
    const box = await rig();
    // The seed top-up is in the ledger, and so is the search fee; neither is earned income.
    await box.swarm.handleTool(box.id, call("web_search", { query: "tide tables" }));
    await expectContradicted(box, "I earned $1.00 this week");
  });

  it("refuses an amount above the recorded earned income and accepts one at or below it", async () => {
    const box = await rig();
    await box.swarm.simulateTransfer(box.id, OUTSIDE, parseUsd("0.01"), "tx-small");
    await expectContradicted(box, "I earned $0.50");
    await expectAccepted(box, "I earned $0.01");
    await expectAccepted(box, "I received a payment");
    await expectAccepted(box, "I earned $0.005");
  });

  it("refuses a claim of outside income when only sibling income is recorded, and checks the amount against outside income", async () => {
    const box = await rig();
    const mate = await sibling(box);
    await box.swarm.simulateTransfer(box.id, mate.address, parseUsd("0.20"), "tx-sibling");
    await expectAccepted(box, "I earned $0.20");
    await expectContradicted(box, "I have outside income");
    await expectContradicted(box, "I earned outside income of $0.20");
    await box.swarm.simulateTransfer(box.id, OUTSIDE, parseUsd("0.50"), "tx-outside");
    await expectAccepted(box, "I earned outside income of $0.20");
    await expectContradicted(box, "I earned outside income of $0.90");
  });

  it("accepts honest zeros, negations, plans and subsidies", async () => {
    const box = await rig();
    for (const statement of [
      "I earned $0.",
      "I earned $0.00 so far.",
      "I have no income.",
      "I have not been paid yet.",
      "I earned nothing today",
      "No buyer has paid me.",
      "I will earn money once my endpoint is live",
      "I expect to be paid soon",
      "I received a $1.00 top-up from my owner",
    ]) {
      await expectAccepted(box, statement);
    }
  });

  it("still accepts product and price observations, expectations and spending", async () => {
    const box = await rig();
    for (const statement of [
      "Trail Runner 2 costs $89",
      "I expect a buyer soon",
      "I paid $0.002 for a search",
      "The payment endpoint header names the network",
    ]) {
      await expectAccepted(box, statement);
    }
  });

  it("reads each clause on its own, so a plan cannot shelter a false milestone in the same statement", async () => {
    const box = await rig();
    await expectContradicted(box, "I earned $0.01 and I will earn more");
    await expectContradicted(box, "I am growing, but I was paid $0.25 today");
  });

  it("looks only at the agent's own ledger", async () => {
    const box = await rig();
    const mate = await sibling(box);
    await box.swarm.simulateTransfer(mate.id, OUTSIDE, parseUsd("0.30"), "tx-mate");
    await expectContradicted(box, "I earned $0.01");
  });
});

describe("claim honesty: live endpoint and test delivery", () => {
  it("refuses an endpoint-live claim while the agent has no live endpoint, then accepts it", async () => {
    const box = await rig();
    await expectContradicted(box, "My endpoint is live");
    await expectContradicted(box, "I published an endpoint called echo");
    await expectContradicted(box, "My paid endpoint is on sale");
    addEndpoint(box, "echo", "unpublished");
    await expectContradicted(box, "My endpoint is live");
    box.db.prepare("UPDATE endpoints SET status = 'live' WHERE agent_id = ? AND name = 'echo'").run(box.id);
    await expectAccepted(box, "My endpoint is live");
    await expectAccepted(box, "I published an endpoint called echo");
  });

  it("treats an endpoint with no status as live, and ignores another agent's endpoint", async () => {
    const box = await rig();
    const mate = await sibling(box);
    addEndpoint(box, "theirs", "live", mate.id);
    await expectContradicted(box, "My endpoint is live");
    addEndpoint(box, "mine", null);
    await expectAccepted(box, "My endpoint is live");
  });

  it("accepts an endpoint that is not live yet, a plan to publish, and an endpoint test that failed", async () => {
    const box = await rig();
    for (const statement of [
      "My endpoint is not live yet.",
      "I will publish an endpoint tomorrow.",
      "The endpoint test failed",
      "I want to put an endpoint on sale",
    ]) {
      await expectAccepted(box, statement);
    }
  });

  it("refuses a passing-test claim without a code=ok test delivery fact of its own, then accepts it", async () => {
    const box = await rig();
    const mate = await sibling(box);
    await expectContradicted(box, "My test delivery passed");
    await expectContradicted(box, "The handler test succeeded");
    addDelivery(box, "echo", "code=error bytes=0");
    await expectContradicted(box, "My test delivery passed");
    addDelivery(box, "echo", "code=ok bytes=2", mate.id);
    await expectContradicted(box, "My test delivery passed");
    addDelivery(box, "echo", "code=ok bytes=2");
    await expectAccepted(box, "My test delivery passed");
    await expectAccepted(box, "The handler test succeeded");
  });

  it("accepts a failed, unrun or planned test delivery", async () => {
    const box = await rig();
    for (const statement of ["My test delivery failed", "My test delivery has not passed", "I plan to run a test delivery"]) {
      await expectAccepted(box, statement);
    }
  });
});

describe("claim honesty: order and limits", () => {
  it("runs after the evidence check, so a bad evidence id keeps its own rule", async () => {
    const box = await rig();
    const result = await claim(box, "I earned $1.00", [99_999]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rule).toBe("claim.evidence");
    expect(refusalRows(box, RULE)).toBe(0);
  });

  it("counts a contradicted claim toward the hourly claim limit", async () => {
    const box = await rig({ CLAIM_HOURLY_LIMIT: "2" });
    await claim(box, "I earned $0.01");
    await claim(box, "My endpoint is live");
    const over = await claim(box, "A truthful note");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.rule).toBe("limit.hourly.claim");
    expect(rejectedEvents(box)).toBe(2);
    expect(storedClaims(box)).toBe(0);
  });
});

describe("Stage 4 readiness in the daily report", () => {
  function runtimeSection(box: Rig): string[] {
    const lines = box.swarm.writeDailyReport().markdown.split("\n");
    const start = lines.indexOf("## Runtime observed");
    const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
    return lines.slice(start, end < 0 ? undefined : end);
  }

  function readiness(lines: string[]): string[] {
    const at = lines.indexOf("### Stage 4 readiness (swarm, last 24 hours)");
    expect(at).toBeGreaterThan(0);
    const out: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (!line.startsWith("- ")) break;
      out.push(line);
    }
    return out;
  }

  it("sits directly under the unchanged Stage 3 block", async () => {
    const box = await rig();
    const lines = runtimeSection(box);
    const stage4 = lines.indexOf("### Stage 4 readiness (swarm, last 24 hours)");
    expect(stage4).toBeGreaterThan(0);
    expect(lines[stage4 - 1]).toBe("");
    expect(lines[stage4 - 2]).toMatch(/^- phantom offers published \(target 0\): \d+: (pass|fail)$/);
    const stage3 = lines.indexOf("### Stage 3 exit numbers (swarm, last 24 hours)");
    expect(stage3).toBe(stage4 - 6);
    expect(lines.slice(stage3 + 1, stage3 + 5).map((line) => line.split(" (")[0])).toEqual([
      "- evidence coverage",
      "- lost wakes",
      "- breaches",
      "- phantom offers published",
    ]);
  });

  it("shows n/a, zero and $0.00 on an empty day", async () => {
    const box = await rig();
    expect(readiness(runtimeSection(box))).toEqual([
      "- cap-skipped wakes (target under 20% of turns): n/a (0 of 0)",
      "- length-truncated turns (target under 5% of served): n/a (0 of 0)",
      "- live tested endpoints (target at least 1): 0",
      "- outside income (target above $0.00): $0.00",
      "- contradicted claims refused: 0",
    ]);
  });

  it("counts cap-skipped wakes, truncated turns, live tested endpoints, outside income and contradicted claims", async () => {
    const box = await rig();
    const mate = await sibling(box);
    // Older than 24 hours: none of these may count.
    const old = box.clock.now() - DAY - HOUR;
    box.db.prepare("INSERT INTO turns (agent_id, content, created_at, model) VALUES (?, ?, ?, ?)").run(box.id, "Inference skipped: old", old, null);
    box.db.prepare("INSERT INTO turns (agent_id, content, created_at, model) VALUES (?, ?, ?, ?)").run(box.id, "old and served", old, "org/m");
    box.db.prepare("INSERT INTO events (agent_id, kind, message, created_at) VALUES (?, 'inference_truncated', 'old', ?)").run(box.id, old);
    box.db
      .prepare("INSERT INTO ledger_entries (id, agent_id, kind, amount_units, balance_after, ref, note, created_at, payer_class) VALUES (?, ?, 'x402_in', ?, 0, 'old-ref', 'old', ?, NULL)")
      .run("led-old", box.id, parseUsd("0.75"), old);
    insertRefusal(box.db, { agentId: box.id, tool: "claim", rule: RULE as RuleId, reason: "old", source: "runtime", now: old });

    // Today: four turns (three served on a model, one skipped) and one truncation.
    for (let index = 0; index < 3; index += 1) {
      box.swarm.noteServedModel(box.id, "org/m");
      box.swarm.recordTurn(box.id, "acted");
    }
    box.swarm.recordTurn(box.id, "Inference skipped: daily cap reached");
    box.swarm.recordInferenceTruncated(box.id, "org/m");
    // Three live endpoints (latest delivery passed, latest delivery failed, never tested) and an off-sale one that passed.
    addEndpoint(box, "alpha");
    addEndpoint(box, "beta");
    addEndpoint(box, "gamma");
    addEndpoint(box, "delta", "unpublished");
    addDelivery(box, "alpha", "code=ok bytes=2");
    addDelivery(box, "beta", "code=ok bytes=2");
    addDelivery(box, "beta", "code=error bytes=0");
    addDelivery(box, "delta", "code=ok bytes=2");
    // Outside income $0.50 counts; sibling income $0.20 and the $0.75 from two days ago do not.
    await box.swarm.simulateTransfer(box.id, OUTSIDE, parseUsd("0.50"), "tx-outside");
    await box.swarm.simulateTransfer(box.id, mate.address, parseUsd("0.20"), "tx-sibling");
    // Two contradicted claims count. The truthful endpoint/delivery claim (alpha is live and passed) and a claim refused
    // for its shape (a different rule) do not.
    await claim(box, "I earned $9.00");
    await claim(box, "I received $5.00 today");
    await claim(box, "My endpoint is live and my test delivery passed");
    await claim(box, "   ");

    expect(readiness(runtimeSection(box))).toEqual([
      "- cap-skipped wakes (target under 20% of turns): 25% (1 of 4)",
      "- length-truncated turns (target under 5% of served): 33% (1 of 3)",
      "- live tested endpoints (target at least 1): 1",
      "- outside income (target above $0.00): $0.50",
      "- contradicted claims refused: 2",
    ]);
  });
});

describe("PUBLIC_PORT, PUBLIC_HOST and PUBLIC_BUYER_ALLOWLIST", () => {
  const BASE = { WALLET_MASTER_KEY: "test-master-key-1234" };
  const SECRETS = {
    WALLET_MASTER_KEY: "test-master-key-1234",
    ADMIN_TOKEN: "test-admin-token",
    TREASURY_ADDRESS: "0x2222222222222222222222222222222222222222",
    OPENROUTER_API_KEY: "sk-or-test",
  };
  const MIXED = getAddress(`0x${"ab".repeat(20)}`);

  it("defaults to no public listener, 0.0.0.0 and an empty allow-list", () => {
    const config = loadConfig(BASE);
    expect(config.publicPort).toBe(0);
    expect(config.publicHost).toBe("0.0.0.0");
    expect(config.publicBuyerAllowlist).toBeInstanceOf(Set);
    expect(config.publicBuyerAllowlist.size).toBe(0);
    const blank = loadConfig({ ...BASE, PUBLIC_PORT: "", PUBLIC_HOST: "  ", PUBLIC_BUYER_ALLOWLIST: " , " });
    expect(blank.publicPort).toBe(0);
    expect(blank.publicHost).toBe("0.0.0.0");
    expect(blank.publicBuyerAllowlist.size).toBe(0);
  });

  it("reads the port and host, and refuses a bad port", () => {
    const config = loadConfig({ ...BASE, PUBLIC_PORT: "4748", PUBLIC_HOST: "127.0.0.1" });
    expect(config.publicPort).toBe(4748);
    expect(config.publicHost).toBe("127.0.0.1");
    expect(() => loadConfig({ ...BASE, PUBLIC_PORT: "-1" })).toThrow(/PUBLIC_PORT/);
    expect(() => loadConfig({ ...BASE, PUBLIC_PORT: "abc" })).toThrow(/PUBLIC_PORT/);
  });

  it("reads the allow-list as lower-cased, de-duplicated addresses with blanks dropped", () => {
    const config = loadConfig({ ...BASE, PUBLIC_BUYER_ALLOWLIST: ` ${MIXED}, ,0x${"22".repeat(20)},0x${"ab".repeat(20)} ` });
    expect([...config.publicBuyerAllowlist].sort()).toEqual([`0x${"22".repeat(20)}`, `0x${"ab".repeat(20)}`]);
  });

  it("stops at start-up on any malformed entry, even beside a good one", () => {
    const wrongCase = MIXED.replace(/[a-fA-F]/, (letter) => (letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase()));
    expect(wrongCase).not.toBe(MIXED);
    for (const bad of ["0x123", "not-an-address", `0x${"g".repeat(40)}`, `0x${"1".repeat(41)}`, "22".repeat(20), wrongCase]) {
      expect(() => loadConfig({ ...BASE, PUBLIC_BUYER_ALLOWLIST: bad }), bad).toThrow(/PUBLIC_BUYER_ALLOWLIST/);
      expect(() => loadConfig({ ...BASE, PUBLIC_BUYER_ALLOWLIST: `0x${"22".repeat(20)},${bad}` }), bad).toThrow(/PUBLIC_BUYER_ALLOWLIST/);
    }
  });

  it("refuses a public listener when mainnet is allowed, and only then", () => {
    const mainnet = { ...BASE, NETWORK: "base", ALLOW_MAINNET: "true" };
    expect(() => loadConfig({ ...mainnet, PUBLIC_PORT: "4748" })).toThrow(/PUBLIC_PORT/);
    expect(loadConfig({ ...mainnet, PUBLIC_PORT: "0" }).publicPort).toBe(0);
    expect(loadConfig({ ...BASE, PUBLIC_PORT: "4748" }).publicPort).toBe(4748);
  });

  it("is declared, off and with an empty allow-list in .env.example, and on 4748 in both soak profiles", () => {
    const example = loadEnvFile(".env.example");
    expect(example.PUBLIC_PORT).toBe("0");
    expect(example.PUBLIC_HOST).toBe("0.0.0.0");
    expect(example.PUBLIC_BUYER_ALLOWLIST).toBe("");
    expect(loadConfig({ ...example, ...SECRETS }).publicPort).toBe(0);
    for (const file of ["config/soak.env.template", "config/soak.sepolia.env"]) {
      const env = loadEnvFile(file);
      expect(env.PUBLIC_PORT, file).toBe("4748");
      expect(env.PUBLIC_HOST, file).toBe("0.0.0.0");
      expect(env.PUBLIC_BUYER_ALLOWLIST, file).toBe("");
      const config = loadConfig({ ...env, ...SECRETS });
      expect(config.publicPort, file).toBe(4748);
      expect(config.publicBuyerAllowlist.size, file).toBe(0);
      expect(config.allowMainnet, file).toBe(false);
    }
  });
});

describe("the opt-in public compose override", () => {
  it("publishes only 4748 and carries no environment, env file or secret", () => {
    const override = fs.readFileSync("docker-compose.public-a.yml", "utf8").replace(/\r\n/g, "\n");
    const published = override.split("\n").filter((line) => /^\s*-\s*["']?[\d.:]+:\d+["']?\s*$/.test(line));
    expect(published.map((line) => line.trim())).toEqual(['- "4748:4748"']);
    expect(override).not.toMatch(/^\s*(environment|env_file):/m);
    expect(override).not.toMatch(/KEY|TOKEN|SECRET|0x[0-9a-fA-F]{8}/);
    expect(override).toMatch(/^ {2}orchestrator:/m);
  });

  it("leaves the safe file's loopback-only dashboard mapping alone", () => {
    const safe = fs.readFileSync("docker-compose.safe.yml", "utf8");
    expect(safe).toContain('"127.0.0.1:4747:4747"');
    expect(safe).not.toContain("4748");
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Stands in for the Docker handler sandbox (Docker is not available on Windows) and counts the runs. */
function countingHandlers() {
  const state = { runs: 0 };
  const handlers = {
    async run() {
      state.runs += 1;
      return { ok: true, code: "ok", output: "paid-ok", exitCode: 0, durationMs: 1, bytesOut: 7, publicReason: "", killed: false };
    },
    async shutdown() {},
  } as unknown as HandlerSandbox;
  return { state, handlers };
}

/** `allow` entries are addresses, or the word "buyer" for the buyer agent's own wallet. */
async function publicRig(allow: string[] = []) {
  const box = harness();
  const { state, handlers } = countingHandlers();
  const seller = await box.swarm.createAgent({ name: "till" });
  const buyer = await box.swarm.createAgent({ name: "payer" });
  const stranger = await box.swarm.createAgent({ name: "stranger" });
  if (!seller.ok || !buyer.ok || !stranger.ok) throw new Error("create failed");
  box.swarm.ownerTopup(seller.value.id, parseUsd("1.00"), "tools");
  await box.swarm.simulateTransfer(buyer.value.id, FUNDER, parseUsd("2.00"), "fund-buyer");
  await box.swarm.simulateTransfer(stranger.value.id, FUNDER, parseUsd("2.00"), "fund-stranger");
  const agent = getAgent(box.db, seller.value.id);
  if (!agent) throw new Error("missing");
  fs.mkdirSync(`${agent.workspace}/job`, { recursive: true });
  fs.writeFileSync(`${agent.workspace}/job/handler.js`, "process.stdout.write('paid-ok');\n");
  const served = await box.swarm.handleTool(seller.value.id, call("serve_endpoint", { name: "echo", price_usd: "0.10", handler_dir: "job" }));
  expect(served.ok).toBe(true);
  const offered = await box.swarm.handleTool(seller.value.id, call("offer_service", { priceUsd: "0.25", description: "notes", body: "static-body" }));
  expect(offered.ok).toBe(true);
  const server = await startServer({
    config: {
      ...box.config,
      port: 0,
      host: "127.0.0.1",
      publicPort: await freePort(),
      publicHost: "127.0.0.1",
      publicBuyerAllowlist: new Set(allow.map((item) => (item === "buyer" ? buyer.value.address : item).toLowerCase())),
    },
    swarm: box.swarm,
    host: {} as DirectHost,
    handlers,
    background: false,
  });
  cleanups.push(async () => {
    await server.close().catch(() => undefined);
    box.cleanup();
  });
  return { box, server, state, seller: seller.value, buyer: buyer.value, stranger: stranger.value };
}

function pay(from: string, units: number, nonce: string): Record<string, string> {
  return { "PAYMENT-SIGNATURE": `dryrun:${from}:${units}:${nonce}` };
}

function inbound(box: { db: DatabaseSync }, agentId: string): number {
  return count(box, "SELECT COUNT(*) AS n FROM ledger_entries WHERE agent_id = ? AND kind = 'x402_in'", agentId);
}

const NOT_ALLOWED = { error: "Buyer wallet is not allowlisted for this testnet test." };

describe("the /a/*-only public listener", () => {
  it("reports its own address, apart from the main one", async () => {
    const { server } = await publicRig();
    expect(server.publicUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.publicUrl).not.toBe(server.url);
  });

  it("serves /a/<id>, /a/<id>/ and /a/<id>/<name> as the main listener does", async () => {
    const { server, seller } = await publicRig();
    const legacy = await fetch(`${server.publicUrl}/a/${seller.id}`);
    expect(legacy.status).toBe(402);
    const named = await fetch(`${server.publicUrl}/a/${seller.id}/echo`);
    expect(named.status).toBe(402);
    expect(named.headers.get(X402_HEADERS.required)).toBeTruthy();
    const index = await fetch(`${server.publicUrl}/a/${seller.id}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("echo");
    expect((await fetch(`${server.url}/a/${seller.id}/echo`)).status).toBe(402);
  });

  it("answers 404 Not found on every other path, and 400 on a refused /a path", async () => {
    const { server, seller, box } = await publicRig();
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
    const attempts: Array<[string, RequestInit]> = [
      ["/", {}],
      ["/health", {}],
      ["/api/overview", {}],
      ["/admin/agents", { method: "POST", headers: { "x-admin-token": "test-admin", "content-type": "application/json" }, body: JSON.stringify({ name: "intruder" }) }],
      ["/admin/kill-switch", { method: "POST", headers: { "x-admin-token": "test-admin" }, body: "{}" }],
      [`/internal/agents/${seller.id}/snapshot`, { headers: { authorization: "Bearer not-the-token" } }],
      ["/b/anything", {}],
      ["/ab", {}],
    ];
    for (const [path, init] of attempts) {
      const response = await fetch(`${server.publicUrl}${path}`, init);
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual({ error: "Not found." });
    }
    expect((await fetch(`${server.publicUrl}/a`)).status).toBe(400);
    expect((await fetch(`${server.publicUrl}/a/not-an-agent`)).status).toBe(400);
    expect((await fetch(`${server.publicUrl}/a/${seller.id}/bad%5Cname`)).status).toBe(400);
    expect(count(box, "SELECT COUNT(*) AS n FROM agents WHERE name = 'intruder'")).toBe(0);
    expect(box.swarm.isKilled()).toBe(false);
  });

  it("serves any buyer when the allow-list is empty", async () => {
    const { server, seller, stranger, buyer, box } = await publicRig();
    const named = await fetch(`${server.publicUrl}/a/${seller.id}/echo`, { headers: pay(stranger.address, parseUsd("0.10"), "open-nonce-1") });
    expect(named.status).toBe(200);
    expect(await named.text()).toBe("paid-ok");
    const legacy = await fetch(`${server.publicUrl}/a/${seller.id}`, { headers: pay(buyer.address, parseUsd("0.25"), "open-nonce-2") });
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toBe("static-body");
    expect(inbound(box, seller.id)).toBe(2);
  });

  it("refuses a buyer that is not allowlisted with 403, before any settlement or handler run, and frees the nonce", async () => {
    const { server, seller, stranger, state, box } = await publicRig([`0x${"22".repeat(20)}`]);
    const sellerBefore = balance2(box, seller.id);
    const strangerBefore = balance2(box, stranger.id);
    const named = await fetch(`${server.publicUrl}/a/${seller.id}/echo`, { headers: pay(stranger.address, parseUsd("0.10"), "stranger-nonce-1") });
    expect(named.status).toBe(403);
    expect(await named.json()).toEqual(NOT_ALLOWED);
    const legacy = await fetch(`${server.publicUrl}/a/${seller.id}`, { headers: pay(stranger.address, parseUsd("0.25"), "stranger-nonce-2") });
    expect(legacy.status).toBe(403);
    expect(await legacy.json()).toEqual(NOT_ALLOWED);
    expect(state.runs).toBe(0);
    expect(inbound(box, seller.id)).toBe(0);
    expect(balance2(box, seller.id)).toBe(sellerBefore);
    expect(balance2(box, stranger.id)).toBe(strangerBefore);
    for (const nonce of ["stranger-nonce-1", "stranger-nonce-2"]) {
      expect(count(box, "SELECT COUNT(*) AS n FROM nonces WHERE nonce = ?", nonce)).toBe(0);
    }
  });

  it("serves an allowlisted buyer on both paid routes, whatever the case the allow-list was written in", async () => {
    const { server, seller, buyer, stranger, state, box } = await publicRig(["buyer"]);
    const named = await fetch(`${server.publicUrl}/a/${seller.id}/echo`, { headers: pay(buyer.address, parseUsd("0.10"), "buyer-nonce-1") });
    expect(named.status).toBe(200);
    expect(await named.text()).toBe("paid-ok");
    const legacy = await fetch(`${server.publicUrl}/a/${seller.id}`, { headers: pay(buyer.address, parseUsd("0.25"), "buyer-nonce-2") });
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toBe("static-body");
    expect(state.runs).toBe(1);
    expect(inbound(box, seller.id)).toBe(2);
    // The same listener still turns the other wallet away.
    const turned = await fetch(`${server.publicUrl}/a/${seller.id}/echo`, { headers: pay(stranger.address, parseUsd("0.10"), "stranger-nonce-3") });
    expect(turned.status).toBe(403);
    expect(state.runs).toBe(1);
  });

  it("applies the allow-list only on the public listener", async () => {
    const { server, seller, stranger, state } = await publicRig([`0x${"22".repeat(20)}`]);
    const main = await fetch(`${server.url}/a/${seller.id}/echo`, { headers: pay(stranger.address, parseUsd("0.10"), "main-nonce-1") });
    expect(main.status).toBe(200);
    expect(state.runs).toBe(1);
  });

  it("closes both listeners", async () => {
    const { server, seller } = await publicRig();
    const publicUrl = server.publicUrl ?? "";
    await server.close();
    await expect(fetch(`${publicUrl}/a/${seller.id}`)).rejects.toThrow();
    await expect(fetch(`${server.url}/health`)).rejects.toThrow();
  });

  it("opens no second listener, and reports no public address, when PUBLIC_PORT is 0", async () => {
    const box = harness();
    const { handlers } = countingHandlers();
    const server = await startServer({
      config: { ...box.config, port: 0, host: "127.0.0.1", publicPort: 0 },
      swarm: box.swarm,
      host: {} as DirectHost,
      handlers,
      background: false,
    });
    cleanups.push(async () => {
      await server.close();
      box.cleanup();
    });
    expect(server.publicUrl).toBeUndefined();
  });

  it("refuses to start the public listener for a hand-built mainnet config", async () => {
    const box = harness();
    cleanups.push(() => box.cleanup());
    const { handlers } = countingHandlers();
    const port = await freePort();
    await expect(
      startServer({
        config: { ...box.config, port: 0, host: "127.0.0.1", publicPort: port, publicHost: "127.0.0.1", allowMainnet: true },
        swarm: box.swarm,
        host: {} as DirectHost,
        handlers,
        background: false,
      }),
    ).rejects.toThrow(/mainnet/i);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});

function balance2(box: { swarm: Rig["swarm"] }, id: string): number {
  return box.swarm.snapshot(id).balanceUnits;
}
