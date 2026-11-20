import { afterEach, describe, expect, it } from "vitest";
import { parseUsd } from "../src/money.js";
import { harness } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

type FactRow = { kind: string; subject: string; value: string; source: string };

function creditFacts(rig: ReturnType<typeof harness>, agentId: string): FactRow[] {
  return rig.db
    .prepare("SELECT kind, subject, value, source FROM facts WHERE agent_id = ? AND kind = 'credit' ORDER BY id")
    .all(agentId) as unknown as FactRow[];
}

describe("credit fact labels (BO-2.1b carry-over)", () => {
  it("writes one replication_in fact, labelled sibling, when a parent funds a child", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const parent = await rig.swarm.createAgent({ name: "parent" });
    if (!parent.ok) throw new Error(parent.error);
    await rig.swarm.simulateTransfer(parent.value.id, "0x4444444444444444444444444444444444444444", parseUsd("5"), "earn-1");
    const child = await rig.swarm.spawnChild(parent.value.id, "child");
    if (!child.ok) throw new Error(child.error);
    const ledger = rig.db
      .prepare("SELECT id, amount_units FROM ledger_entries WHERE agent_id = ? AND kind = 'replication_in'")
      .get(child.value.id) as { id: string; amount_units: number };
    const facts = creditFacts(rig, child.value.id);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual({
      kind: "credit",
      subject: "replication_in",
      value: `units=${ledger.amount_units} payer_class=sibling`,
      source: `ledger:${ledger.id}`,
    });
  });

  it("writes no replication fact for the parent's side of the endowment", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const parent = await rig.swarm.createAgent({ name: "parent" });
    if (!parent.ok) throw new Error(parent.error);
    await rig.swarm.simulateTransfer(parent.value.id, "0x4444444444444444444444444444444444444444", parseUsd("5"), "earn-1");
    const before = creditFacts(rig, parent.value.id).length;
    await rig.swarm.spawnChild(parent.value.id, "child");
    expect(creditFacts(rig, parent.value.id)).toHaveLength(before);
  });

  it("labels an owner top-up fact payer_class=owner", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "scout" });
    if (!agent.ok) throw new Error(agent.error);
    rig.swarm.ownerTopup(agent.value.id, parseUsd("2"), "seed");
    const [fact] = creditFacts(rig, agent.value.id);
    expect(fact?.subject).toBe("owner_topup");
    expect(fact?.value).toBe(`units=${parseUsd("2")} payer_class=owner`);
  });

  it("leaves outside-income accounting unchanged: neither label counts as outside income", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const parent = await rig.swarm.createAgent({ name: "parent" });
    if (!parent.ok) throw new Error(parent.error);
    rig.swarm.ownerTopup(parent.value.id, parseUsd("3"), "seed");
    await rig.swarm.simulateTransfer(parent.value.id, "0x4444444444444444444444444444444444444444", parseUsd("5"), "earn-1");
    const child = await rig.swarm.spawnChild(parent.value.id, "child");
    if (!child.ok) throw new Error(child.error);
    const agents = rig.swarm.overview().agents as Array<{ id: string; outsideIncomeUnits: number; subsidyUnits: number }>;
    const parentRow = agents.find((row) => row.id === parent.value.id);
    const childRow = agents.find((row) => row.id === child.value.id);
    expect(parentRow?.outsideIncomeUnits).toBe(parseUsd("5"));
    expect(childRow?.outsideIncomeUnits).toBe(0);
    expect(childRow?.subsidyUnits).toBe(parseUsd("1"));
  });
});
