import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { kvSet } from "../src/db.js";
import { parseUsd } from "../src/money.js";
import { MockSearch } from "../src/search.js";
import { Swarm } from "../src/swarm.js";
import { RentScheduler } from "../src/survival.js";
import { harness } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("rent scheduler and death", () => {
  it("archives an unfunded agent after grace and keeps a topped-up agent alive", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const poor = await rig.swarm.createAgent({ name: "ash" });
    const rich = await rig.swarm.createAgent({ name: "brine" });
    if (!poor.ok || !rich.ok) throw new Error("create failed");
    rig.swarm.ownerTopup(rich.value.id, parseUsd("5.00"), "seed");

    rig.clock.advance(1000);
    await rig.swarm.runMaintenance();
    expect(rig.swarm.snapshot(poor.value.id).status).toBe("grace");
    expect(rig.swarm.snapshot(rich.value.id).status).toBe("running");
    expect(rig.swarm.snapshot(rich.value.id).balanceUnits).toBe(parseUsd("4.00"));

    rig.clock.advance(5000);
    await rig.swarm.runMaintenance();
    expect(rig.swarm.snapshot(poor.value.id).status).toBe("archived");
    expect(rig.runtime.stopped).toContain(poor.value.id);
    expect(fs.existsSync(path.join(rig.dir, "archives", poor.value.id, "manifest.json"))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(rig.dir, "archives", poor.value.id, "manifest.json"), "utf8"));
    expect(manifest.address).toBe(poor.value.address);
    expect(manifest.treasury).toBe(rig.config.treasury);
    expect(rig.swarm.snapshot(rich.value.id).status).toBe("running");
    expect(rig.swarm.snapshot(rich.value.id).balanceUnits).toBe(parseUsd("3.00"));
  });

  it("lets a top-up during grace cancel death", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "late" });
    if (!agent.ok) throw new Error(agent.error);
    rig.clock.advance(1000);
    await rig.swarm.runMaintenance();
    expect(rig.swarm.snapshot(agent.value.id).status).toBe("grace");
    rig.swarm.ownerTopup(agent.value.id, parseUsd("3.00"), "saved");
    expect(rig.swarm.snapshot(agent.value.id).status).toBe("running");
    rig.clock.advance(5000);
    await rig.swarm.runMaintenance();
    expect(rig.swarm.snapshot(agent.value.id).status).toBe("running");
    expect(rig.swarm.snapshot(agent.value.id).balanceUnits).toBeGreaterThan(0);
  });

  it("sweeps simulated USDC to the treasury when an agent dies", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "dust" });
    if (!agent.ok) throw new Error(agent.error);
    await rig.swarm.simulateTransfer(agent.value.id, "0x3333333333333333333333333333333333333333", parseUsd("0.40"), "tx-dust");
    rig.clock.advance(1000);
    await rig.swarm.runMaintenance();
    rig.clock.advance(5000);
    await rig.swarm.runMaintenance();
    expect(rig.swarm.snapshot(agent.value.id).status).toBe("archived");
    const treasury = await rig.chain.getBalance(rig.config.treasury);
    expect(treasury.ok && treasury.units).toBe(BigInt(parseUsd("0.40")));
    const left = await rig.chain.getBalance(agent.value.address);
    expect(left.ok && left.units).toBe(0n);
  });

  it("still charges rent when a saved due-time is ahead of the restarted clock", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    kvSet(rig.db, "last_rent_at", String(rig.clock.now() + 50_000_000));
    const restarted = new Swarm(rig.db, rig.config, rig.clock, rig.chain, rig.runtime, new MockSearch());
    const poor = await restarted.createAgent({ name: "reboot" });
    if (!poor.ok) throw new Error(poor.error);
    rig.clock.advance(1000);
    await restarted.runMaintenance();
    expect(restarted.snapshot(poor.value.id).status).toBe("grace");
  });

  it("fires the scheduler on its own interval", async () => {
    let runs = 0;
    const scheduler = new RentScheduler(() => {
      runs += 1;
    }, 20);
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 70));
    scheduler.stop();
    expect(runs).toBeGreaterThanOrEqual(2);
  });
});
