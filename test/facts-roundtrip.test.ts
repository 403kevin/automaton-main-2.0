import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DryRunChain } from "../src/chain.js";
import { getAgent } from "../src/db.js";
import type { HandlerRunResult } from "../src/handlers.js";
import { parseUsd } from "../src/money.js";
import { computeActual, CREDIT_VALUE, DELIVERY_VALUE, OK_DELIVERY, type Metric } from "../src/predictions.js";
import type { BrowseTaskResult, CrawlSiteResult, FeedResult, SeePageResult, SensesClient } from "../src/senses-client.js";
import type { ToolCall } from "../src/types.js";
import type { OfferVerifier } from "../src/verify-offer.js";
import { harness } from "./helpers.js";

const HOUR = 3_600_000;
const OUTSIDE = "0x2222222222222222222222222222222222222222";
const PAGE = "http://93.184.216.34/page";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

class Probe implements SensesClient {
  async see(): Promise<SeePageResult> {
    return { title: "Shop", markdown: "Trail Runner 2, $89.", links: [] };
  }
  async crawl(): Promise<CrawlSiteResult> {
    throw new Error("not stubbed");
  }
  async feed(): Promise<FeedResult> {
    throw new Error("not stubbed");
  }
  async browse(): Promise<BrowseTaskResult> {
    throw new Error("not stubbed");
  }
}

class Verifier implements OfferVerifier {
  queue: HandlerRunResult[] = [];
  async test(): Promise<HandlerRunResult> {
    return (
      this.queue.shift() ?? { ok: true, code: "ok", output: "fine", exitCode: 0, durationMs: 1, bytesOut: 4, publicReason: "", killed: false }
    );
  }
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `${name}-${Math.random().toString(16).slice(2, 8)}`, name, arguments: args };
}

describe("the real fact writers and the settlement parsers agree", () => {
  it("counts every real writer's output for the right metric, settles predictions on them, and every fact value matches the parsers", async () => {
    const box = harness({ DAILY_RENT_USD: "0.0001" }, undefined, undefined, new Probe());
    cleanups.push(box.cleanup);
    const verifier = new Verifier();
    box.swarm.setOfferVerifier(verifier);
    const seller = await box.swarm.createAgent({ name: "maker" });
    const buyer = await box.swarm.createAgent({ name: "buyer" });
    if (!seller.ok || !buyer.ok) throw new Error("create failed");
    box.swarm.ownerTopup(seller.value.id, parseUsd("5"), "seed-seller");
    // A dry-run payer pays from a simulated chain balance: the sibling buyer as in hands.test.ts, the outside payer directly.
    await box.swarm.simulateTransfer(buyer.value.id, "0x8888888888888888888888888888888888888888", parseUsd("1"), "fund-buyer");
    await (box.chain as DryRunChain).fund(OUTSIDE, 10_000n);
    const agent = getAgent(box.db, seller.value.id);
    if (!agent) throw new Error("missing");
    fs.mkdirSync(path.join(agent.workspace, "job"), { recursive: true });
    fs.writeFileSync(path.join(agent.workspace, "job", "handler.js"), "process.stdout.write('x');\n");

    const T = box.clock.now();
    const expected: Record<Metric, number> = { income_outside_units: 7000, income_sibling_units: 3000, test_deliveries_ok: 1, sense_results: 1 };
    for (const metric of Object.keys(expected) as Metric[]) {
      const made = await box.swarm.handleTool(seller.value.id, call("predict", { metric, op: "=", value: expected[metric], deadline_hours: 1 }));
      expect(made.ok, metric).toBe(true);
    }
    box.clock.advance(1000);

    // An outside x402 payment and a sibling x402 payment, through the dry-run payment path (the real writer).
    const outside = await box.swarm.verifyInboundPayment(seller.value.id, `dryrun:${OUTSIDE}:5000:nonce-outside`, 5000);
    if (!outside.ok) throw new Error(outside.error);
    expect((await box.swarm.commitInboundPayment(seller.value.id, outside.value)).ok).toBe(true);
    const sibling = await box.swarm.verifyInboundPayment(seller.value.id, `dryrun:${buyer.value.address}:3000:nonce-sibling`, 3000);
    if (!sibling.ok) throw new Error(sibling.error);
    expect((await box.swarm.commitInboundPayment(seller.value.id, sibling.value)).ok).toBe(true);
    // An outside on-chain credit.
    expect(box.swarm.creditIncome(seller.value.id, 2000, "0xroundtrip", OUTSIDE).ok).toBe(true);
    // A failing and a passing endpoint test, through the fake verifier.
    verifier.queue.push({ ok: false, code: "error", output: "", exitCode: 1, durationMs: 1, bytesOut: 0, publicReason: "handler error", killed: false });
    expect((await box.swarm.handleTool(seller.value.id, call("serve_endpoint", { name: "echo", price_usd: "0.01", handler_dir: "job" }))).ok).toBe(false);
    expect((await box.swarm.handleTool(seller.value.id, call("serve_endpoint", { name: "echo", price_usd: "0.01", handler_dir: "job" }))).ok).toBe(true);
    // An ok sense call, and a refused one that writes no fact.
    expect((await box.swarm.handleTool(seller.value.id, call("see_page", { url: PAGE }))).ok).toBe(true);
    expect((await box.swarm.handleTool(seller.value.id, call("see_page", { url: "http://127.0.0.1/admin" }))).ok).toBe(false);

    for (const metric of Object.keys(expected) as Metric[]) {
      expect(computeActual(box.db, seller.value.id, metric, T, T + HOUR), metric).toBe(expected[metric]);
    }

    await box.swarm.advance(HOUR + 1000);
    const rows = box.db.prepare("SELECT metric, status, actual FROM predictions WHERE agent_id = ? ORDER BY id").all(seller.value.id) as unknown as Array<{
      metric: string;
      status: string;
      actual: number;
    }>;
    expect(rows.map((row) => [row.metric, row.status, row.actual])).toEqual(
      (Object.keys(expected) as Metric[]).map((metric) => [metric, "hit", expected[metric]]),
    );

    // A child's endowment, so that replication_in is among the facts checked below.
    const parent = await box.swarm.createAgent({ name: "parent" });
    if (!parent.ok) throw new Error(parent.error);
    await box.swarm.simulateTransfer(parent.value.id, OUTSIDE, parseUsd("5"), "earn-parent");
    expect((await box.swarm.spawnChild(parent.value.id, "child")).ok).toBe(true);

    const credits = box.db.prepare("SELECT subject, value FROM facts WHERE kind = 'credit'").all() as unknown as Array<{ subject: string; value: string }>;
    expect(new Set(credits.map((row) => row.subject))).toEqual(new Set(["owner_topup", "x402_in", "onchain_income", "replication_in"]));
    for (const row of credits) expect(row.value, `${row.subject}: ${row.value}`).toMatch(CREDIT_VALUE);
    const deliveries = box.db.prepare("SELECT value FROM facts WHERE kind = 'test_delivery'").all() as unknown as Array<{ value: string }>;
    expect(deliveries.map((row) => row.value).sort()).toHaveLength(2);
    for (const row of deliveries) expect(row.value).toMatch(DELIVERY_VALUE);
    expect(deliveries.filter((row) => OK_DELIVERY.test(row.value))).toHaveLength(1);
  });
});
