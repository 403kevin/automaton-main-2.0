import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DryRunChain } from "../src/chain.js";
import { ManualClock } from "../src/clock.js";
import { openDatabase } from "../src/db.js";
import { parseUsd } from "../src/money.js";
import { classifyPayer } from "../src/payer.js";
import { MockSearch } from "../src/search.js";
import { Swarm } from "../src/swarm.js";
import { harness } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const OUTSIDE = "0x2222222222222222222222222222222222222222";
const OTHER_OUTSIDE = "0x3333333333333333333333333333333333333333";

describe("outside money", () => {
  it("tags a sibling payment as sibling and does not unlock spawn; the same size from outside does", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const parent = await rig.swarm.createAgent({ name: "parent" });
    const sibling = await rig.swarm.createAgent({ name: "kin" });
    if (!parent.ok || !sibling.ok) throw new Error("create failed");
    rig.swarm.ownerTopup(parent.value.id, parseUsd("2.00"), "seed");

    const fromKin = await rig.swarm.simulateTransfer(parent.value.id, sibling.value.address, parseUsd("1.00"), "from-kin");
    expect(fromKin.ok).toBe(true);
    expect(payerClass(rig.db, parent.value.id, "onchain:from-kin")).toBe("sibling");
    expect(eventClass(rig.db, parent.value.id, "income")).toBe("sibling");
    const blocked = await rig.swarm.spawnChild(parent.value.id, "child");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/swarm wallets/);

    const fromWorld = await rig.swarm.simulateTransfer(parent.value.id, OUTSIDE, parseUsd("1.00"), "from-world");
    expect(fromWorld.ok).toBe(true);
    expect(payerClass(rig.db, parent.value.id, "onchain:from-world")).toBe("outside");
    expect(eventClass(rig.db, parent.value.id, "income")).toBe("outside");
    const child = await rig.swarm.spawnChild(parent.value.id, "child");
    expect(child.ok).toBe(true);
  });

  it("tags an x402 sibling payment as sibling and an outside payment of the same size as outside", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const seller = await rig.swarm.createAgent({ name: "seller" });
    const buyer = await rig.swarm.createAgent({ name: "buyer" });
    if (!seller.ok || !buyer.ok) throw new Error("create failed");
    rig.swarm.ownerTopup(seller.value.id, parseUsd("2.00"), "seed");
    publishOffer(rig.db, seller.value.id, parseUsd("1.00"));
    await rig.swarm.simulateTransfer(buyer.value.id, OUTSIDE, parseUsd("1.00"), "fund-buyer");

    const paid = await rig.swarm.settleDryPayment(
      seller.value.id,
      `dryrun:${buyer.value.address}:${parseUsd("1.00")}:sibling01`,
    );
    expect(paid.ok).toBe(true);
    expect(payerClass(rig.db, seller.value.id, "x402-in:sibling01")).toBe("sibling");
    expect(eventClass(rig.db, seller.value.id, "x402_in")).toBe("sibling");
    const blocked = await rig.swarm.spawnChild(seller.value.id, "child");
    expect(blocked.ok).toBe(false);

    await rig.chain.fund(OTHER_OUTSIDE, BigInt(parseUsd("1.00")));
    const outside = await rig.swarm.settleDryPayment(
      seller.value.id,
      `dryrun:${OTHER_OUTSIDE}:${parseUsd("1.00")}:outside01`,
    );
    expect(outside.ok).toBe(true);
    expect(payerClass(rig.db, seller.value.id, "x402-in:outside01")).toBe("outside");
    const before = agentRow(rig.swarm, seller.value.id);
    expect(before.siblingIncomeUnits).toBe(parseUsd("1.00"));
    expect(before.outsideIncomeUnits).toBe(parseUsd("1.00"));
    expect(before.netOfCostUnits).toBe(parseUsd("1.00"));
    const child = await rig.swarm.spawnChild(seller.value.id, "child");
    expect(child.ok).toBe(true);
  });

  it("still treats an archived sibling wallet as sibling", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const gone = await rig.swarm.createAgent({ name: "gone" });
    if (!gone.ok) throw new Error(gone.error);
    rig.clock.advance(1000);
    await rig.swarm.runMaintenance();
    rig.clock.advance(5000);
    await rig.swarm.runMaintenance();
    expect(rig.swarm.snapshot(gone.value.id).status).toBe("archived");

    const parent = await rig.swarm.createAgent({ name: "parent" });
    if (!parent.ok) throw new Error(parent.error);
    rig.swarm.ownerTopup(parent.value.id, parseUsd("2.00"), "seed");
    const paid = await rig.swarm.simulateTransfer(parent.value.id, gone.value.address, parseUsd("1.00"), "from-archive");
    expect(paid.ok).toBe(true);
    expect(payerClass(rig.db, parent.value.id, "onchain:from-archive")).toBe("sibling");
    const blocked = await rig.swarm.spawnChild(parent.value.id, "child");
    expect(blocked.ok).toBe(false);

    await rig.swarm.simulateTransfer(parent.value.id, OUTSIDE, parseUsd("1.00"), "from-world");
    const child = await rig.swarm.spawnChild(parent.value.id, "child");
    expect(child.ok).toBe(true);
  });

  it("counts a self-payment as sibling and does not credit it", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "solo" });
    if (!agent.ok) throw new Error(agent.error);
    rig.swarm.ownerTopup(agent.value.id, parseUsd("2.00"), "seed");
    const wallets = (rig.db.prepare("SELECT wallet_address FROM agents").all() as unknown as { wallet_address: string }[]).map(
      (row) => row.wallet_address,
    );
    expect(classifyPayer(agent.value.address, [rig.config.treasury, ...wallets])).toBe("sibling");
    expect(classifyPayer(OUTSIDE, [rig.config.treasury, ...wallets])).toBe("outside");
    expect(classifyPayer(rig.config.treasury, [rig.config.treasury, ...wallets])).toBe("sibling");

    const self = await rig.swarm.simulateTransfer(agent.value.id, agent.value.address, parseUsd("1.00"), "from-self");
    expect(self.ok).toBe(false);
    expect(eventClass(rig.db, agent.value.id, "rejected_claim")).toBe("sibling");
    expect(rig.swarm.snapshot(agent.value.id).balanceUnits).toBe(parseUsd("2.00"));
    const blocked = await rig.swarm.spawnChild(agent.value.id, "child");
    expect(blocked.ok).toBe(false);
    const row = agentRow(rig.swarm, agent.value.id);
    expect(row.siblingIncomeUnits).toBe(0);
    expect(row.outsideIncomeUnits).toBe(0);
    expect(row.netOfCostUnits).toBe(0);
  });

  it("tags a payment from the gas funder as sibling", async () => {
    const key = generatePrivateKey();
    const rig = harness({ GAS_FUNDER_PRIVATE_KEY: key });
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "paid" });
    if (!agent.ok) throw new Error(agent.error);
    rig.swarm.ownerTopup(agent.value.id, parseUsd("2.00"), "seed");
    const funder = privateKeyToAccount(key).address;
    const paid = await rig.swarm.simulateTransfer(agent.value.id, funder, parseUsd("1.00"), "from-funder");
    expect(paid.ok).toBe(true);
    expect(payerClass(rig.db, agent.value.id, "onchain:from-funder")).toBe("sibling");
    const blocked = await rig.swarm.spawnChild(agent.value.id, "child");
    expect(blocked.ok).toBe(false);
  });

  it("tags a treasury payment as sibling", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "paid" });
    if (!agent.ok) throw new Error(agent.error);
    rig.swarm.ownerTopup(agent.value.id, parseUsd("2.00"), "seed");
    const paid = await rig.swarm.simulateTransfer(agent.value.id, rig.config.treasury, parseUsd("1.00"), "from-treasury");
    expect(paid.ok).toBe(true);
    expect(payerClass(rig.db, agent.value.id, "onchain:from-treasury")).toBe("sibling");
    expect(eventClass(rig.db, agent.value.id, "income")).toBe("sibling");
    const blocked = await rig.swarm.spawnChild(agent.value.id, "child");
    expect(blocked.ok).toBe(false);
  });

  it("subtracts the agent's own costs from outside income before spawn", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "books" });
    if (!agent.ok) throw new Error(agent.error);
    rig.swarm.ownerTopup(agent.value.id, parseUsd("2.00"), "seed");
    const spent = rig.swarm.debit(agent.value.id, parseUsd("0.10"), "tool", "tool-1", "shell");
    expect(spent.ok).toBe(true);
    await rig.swarm.simulateTransfer(agent.value.id, OUTSIDE, parseUsd("1.00"), "earn");
    const short = await rig.swarm.spawnChild(agent.value.id, "child");
    expect(short.ok).toBe(false);
    await rig.swarm.simulateTransfer(agent.value.id, OTHER_OUTSIDE, parseUsd("0.10"), "earn-more");
    const child = await rig.swarm.spawnChild(agent.value.id, "child");
    expect(child.ok).toBe(true);
    expect(agentRow(rig.swarm, agent.value.id).netOfCostUnits).toBe(parseUsd("0.00"));
  });

  it("shows outside income, sibling income, and net of cost on the report", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "mite" });
    const sibling = await rig.swarm.createAgent({ name: "kin" });
    if (!agent.ok || !sibling.ok) throw new Error("create failed");
    rig.swarm.ownerTopup(agent.value.id, parseUsd("2.00"), "seed");
    rig.swarm.debit(agent.value.id, parseUsd("0.25"), "tool", "tool-1", "shell");
    await rig.swarm.simulateTransfer(agent.value.id, sibling.value.address, parseUsd("5.00"), "from-kin");
    await rig.swarm.simulateTransfer(agent.value.id, OUTSIDE, parseUsd("1.50"), "from-world");

    const row = agentRow(rig.swarm, agent.value.id);
    expect(row.outsideIncome).toBe("$1.50");
    expect(row.siblingIncome).toBe("$5.00");
    expect(row.netOfCost).toBe("$1.25");
    expect(row.income).toBe(row.netOfCost);

    const report = rig.swarm.writeDailyReport();
    expect(report.markdown).toContain("Untagged inbound ledger rows have no payer class. They count as outside income.");
    expect(report.markdown).toContain("- outside income: $1.50");
    expect(report.markdown).toContain("- sibling income: $5.00");
    expect(report.markdown).toContain("- net of cost: $1.25");
    expect(rig.swarm.overview().dailyReport).toContain("- sibling income: $5.00");
  });

  it("migrates an old ledger without rewriting rows, and counts a missing payer class as outside", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const file = path.join(rig.dir, "legacy.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE ledger_entries (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        amount_units INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        ref TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(agent_id, ref)
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    raw
      .prepare(
        "INSERT INTO ledger_entries (id, agent_id, kind, amount_units, balance_after, ref, note, created_at) VALUES (?, ?, 'onchain_income', ?, ?, ?, ?, ?)",
      )
      .run("led-old", "later", parseUsd("1.00"), parseUsd("1.00"), "onchain:old", "from 0xabc", 1);
    raw.close();

    const db = openDatabase(file);
    const ledgerCols = db.prepare("PRAGMA table_info(ledger_entries)").all() as unknown as { name: string }[];
    const eventCols = db.prepare("PRAGMA table_info(events)").all() as unknown as { name: string }[];
    expect(ledgerCols.some((col) => col.name === "payer_class")).toBe(true);
    expect(eventCols.some((col) => col.name === "payer_class")).toBe(true);
    const legacy = db.prepare("SELECT payer_class, amount_units FROM ledger_entries WHERE id = ?").get("led-old") as {
      payer_class: string | null;
      amount_units: number;
    };
    expect(legacy.payer_class).toBeNull();
    expect(legacy.amount_units).toBe(parseUsd("1.00"));

    const swarm = new Swarm(db, rig.config, new ManualClock(rig.clock.now()), new DryRunChain(db), rig.runtime, new MockSearch());
    const agent = await swarm.createAgent({ name: "heir" });
    if (!agent.ok) throw new Error(agent.error);
    swarm.ownerTopup(agent.value.id, parseUsd("2.00"), "seed");
    db.prepare("UPDATE ledger_entries SET agent_id = ? WHERE id = ?").run(agent.value.id, "led-old");
    db.prepare("UPDATE agents SET balance_units = balance_units + ? WHERE id = ?").run(parseUsd("1.00"), agent.value.id);

    const row = agentRow(swarm, agent.value.id);
    expect(row.outsideIncomeUnits).toBe(parseUsd("1.00"));
    expect(row.siblingIncomeUnits).toBe(0);
    expect(row.netOfCostUnits).toBe(parseUsd("1.00"));
    const child = await swarm.spawnChild(agent.value.id, "child");
    expect(child.ok).toBe(true);
  });
});

function publishOffer(db: DatabaseSync, agentId: string, price: number): void {
  db.prepare(
    "INSERT INTO services (agent_id, price_units, description, body, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(agentId, price, "A note from an AI.", "This answer was written by an AI agent.", 1);
}

function payerClass(db: DatabaseSync, agentId: string, ref: string): string | null {
  const row = db.prepare("SELECT payer_class FROM ledger_entries WHERE agent_id = ? AND ref = ?").get(agentId, ref) as
    | { payer_class: string | null }
    | undefined;
  if (!row) throw new Error(`missing ledger row ${ref}`);
  return row.payer_class;
}

function eventClass(db: DatabaseSync, agentId: string, kind: string): string | null {
  const row = db
    .prepare("SELECT payer_class FROM events WHERE agent_id = ? AND kind = ? ORDER BY id DESC LIMIT 1")
    .get(agentId, kind) as { payer_class: string | null } | undefined;
  if (!row) throw new Error(`missing event ${kind}`);
  return row.payer_class;
}

function agentRow(swarm: Swarm, agentId: string) {
  const row = swarm.overview().agents.find((agent) => agent.id === agentId);
  if (!row) throw new Error("missing agent");
  return row;
}
