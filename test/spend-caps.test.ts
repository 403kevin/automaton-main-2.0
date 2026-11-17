import { afterEach, describe, expect, it } from "vitest";
import { parseUsd } from "../src/money.js";
import { harness } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("spend caps", () => {
  it("enforces per-agent and global caps before a debit", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const first = await rig.swarm.createAgent({ name: "alpha" });
    const second = await rig.swarm.createAgent({ name: "beta" });
    if (!first.ok || !second.ok) throw new Error("create failed");
    rig.swarm.ownerTopup(first.value.id, parseUsd("10"), "a");
    rig.swarm.ownerTopup(second.value.id, parseUsd("10"), "b");

    expect(rig.swarm.debit(first.value.id, parseUsd("1.50"), "inference", "i1", "model").ok).toBe(true);
    const blocked = rig.swarm.debit(first.value.id, parseUsd("0.60"), "inference", "i2", "model");
    expect(blocked.ok).toBe(false);
    expect(rig.swarm.snapshot(first.value.id).balanceUnits).toBe(parseUsd("8.50"));

    expect(rig.swarm.debit(second.value.id, parseUsd("1.50"), "inference", "i3", "model").ok).toBe(true);
    const global = rig.swarm.debit(second.value.id, parseUsd("0.10"), "tool", "i4", "search");
    expect(global.ok).toBe(false);
    expect(rig.swarm.snapshot(second.value.id).balanceUnits).toBe(parseUsd("8.50"));
  });

  it("blocks LLM-class spend when the kill switch is on, and still charges rent", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "halt" });
    if (!agent.ok) throw new Error(agent.error);
    rig.swarm.ownerTopup(agent.value.id, parseUsd("5"), "seed");
    await rig.swarm.setKillSwitch(true);
    const denied = rig.swarm.debit(agent.value.id, parseUsd("0.10"), "inference", "blocked", "model");
    expect(denied.ok).toBe(false);
    expect(rig.swarm.snapshot(agent.value.id).balanceUnits).toBe(parseUsd("5"));
    rig.clock.advance(1000);
    await rig.swarm.runMaintenance();
    expect(rig.swarm.snapshot(agent.value.id).balanceUnits).toBe(parseUsd("4"));
    expect(rig.runtime.stopped).toContain(agent.value.id);
  });

  it("still charges rent after the daily cap is exhausted", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "capped" });
    if (!agent.ok) throw new Error(agent.error);
    rig.swarm.ownerTopup(agent.value.id, parseUsd("10"), "seed");
    expect(rig.swarm.debit(agent.value.id, parseUsd("2.00"), "inference", "max", "model").ok).toBe(true);
    rig.clock.advance(1000);
    await rig.swarm.runMaintenance();
    expect(rig.swarm.snapshot(agent.value.id).balanceUnits).toBe(parseUsd("7.00"));
  });
});
