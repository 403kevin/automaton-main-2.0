import { afterEach, describe, expect, it } from "vitest";
import { getAgent } from "../src/db.js";
import { parseUsd } from "../src/money.js";
import { harness } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("replication", () => {
  it("funds a mutated child from earned profit and refuses a mere subsidy", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const parent = await rig.swarm.createAgent({ name: "parent", genesisPrompt: "Keep the books honest and stay alive." });
    if (!parent.ok) throw new Error(parent.error);
    rig.swarm.ownerTopup(parent.value.id, parseUsd("10"), "subsidy");
    const subsidized = await rig.swarm.spawnChild(parent.value.id, "subsidy-child");
    expect(subsidized.ok).toBe(false);

    await rig.swarm.simulateTransfer(parent.value.id, "0x4444444444444444444444444444444444444444", parseUsd("5"), "earn-1");
    const child = await rig.swarm.spawnChild(parent.value.id, "child");
    if (!child.ok) throw new Error(child.error);
    expect(rig.swarm.snapshot(parent.value.id).balanceUnits).toBe(parseUsd("14.00"));
    expect(rig.swarm.snapshot(child.value.id).balanceUnits).toBe(parseUsd("1.00"));
    expect(child.value.depth).toBe(1);
    const childRow = getAgent(rig.db, child.value.id);
    expect(childRow?.genesisPrompt).toContain("Keep the books honest");
    expect(childRow?.genesisPrompt).toContain("<lineage>");
    expect(childRow?.strategyNotes).toContain("mutation-seed:");
    expect(childRow?.walletAddress).not.toBe(parent.value.address);

    const tooSoon = await rig.swarm.spawnChild(child.value.id, "grand");
    expect(tooSoon.ok).toBe(false);

    await rig.swarm.simulateTransfer(child.value.id, "0x5555555555555555555555555555555555555555", parseUsd("3"), "earn-2");
    const grand = await rig.swarm.spawnChild(child.value.id, "grand");
    if (!grand.ok) throw new Error(grand.error);
    expect(grand.value.depth).toBe(2);
    await rig.swarm.simulateTransfer(grand.value.id, "0x6666666666666666666666666666666666666666", parseUsd("3"), "earn-3");
    const tooDeep = await rig.swarm.spawnChild(grand.value.id, "great");
    expect(tooDeep.ok).toBe(false);
  });

  it("stops at the population cap", async () => {
    const rig = harness({ MAX_POPULATION: "2" });
    cleanups.push(rig.cleanup);
    const parent = await rig.swarm.createAgent({ name: "root" });
    if (!parent.ok) throw new Error(parent.error);
    await rig.swarm.simulateTransfer(parent.value.id, "0x7777777777777777777777777777777777777777", parseUsd("5"), "earn");
    const first = await rig.swarm.spawnChild(parent.value.id, "one");
    expect(first.ok).toBe(true);
    const second = await rig.swarm.spawnChild(parent.value.id, "two");
    expect(second.ok).toBe(false);
  });
});
