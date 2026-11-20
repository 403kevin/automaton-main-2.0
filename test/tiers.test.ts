import { afterEach, describe, expect, it } from "vitest";
import { parseUsd } from "../src/money.js";
import { harness } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("survival tiers", () => {
  it("selects heretic-capable model ids from balance, including a per-agent override", async () => {
    // The per-agent override must be on ALLOWED_MODELS (BO-2.4b).
    const rig = harness({ ALLOWED_MODELS: "org/heretic-normal,org/heretic-low,org/heretic-critical,org/custom-heretic" });
    cleanups.push(rig.cleanup);
    const broke = await rig.swarm.createAgent({ name: "broke" });
    const critical = await rig.swarm.createAgent({ name: "thin" });
    const low = await rig.swarm.createAgent({ name: "low" });
    const full = await rig.swarm.createAgent({ name: "full" });
    const custom = await rig.swarm.createAgent({ name: "custom", model: "org/custom-heretic" });
    if (!broke.ok || !critical.ok || !low.ok || !full.ok || !custom.ok) throw new Error("create failed");
    rig.swarm.ownerTopup(critical.value.id, parseUsd("0.10"), "c");
    rig.swarm.ownerTopup(low.value.id, parseUsd("0.50"), "l");
    rig.swarm.ownerTopup(full.value.id, parseUsd("2.00"), "f");
    rig.swarm.ownerTopup(custom.value.id, parseUsd("2.00"), "u");

    expect(rig.swarm.snapshot(broke.value.id).tier).toBe("critical");
    expect(rig.swarm.snapshot(broke.value.id).model).toBe("org/heretic-critical");
    expect(rig.swarm.snapshot(critical.value.id).tier).toBe("critical");
    expect(rig.swarm.snapshot(critical.value.id).model).toBe("org/heretic-critical");
    expect(rig.swarm.snapshot(low.value.id).tier).toBe("low_compute");
    expect(rig.swarm.snapshot(low.value.id).model).toBe("org/heretic-low");
    expect(rig.swarm.snapshot(full.value.id).tier).toBe("normal");
    expect(rig.swarm.snapshot(full.value.id).model).toBe("org/heretic-normal");
    expect(rig.swarm.snapshot(custom.value.id).model).toBe("org/custom-heretic");
  });

  it("drops the model with the tier after rent", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "slide" });
    if (!agent.ok) throw new Error(agent.error);
    rig.swarm.ownerTopup(agent.value.id, parseUsd("1.20"), "seed");
    expect(rig.swarm.snapshot(agent.value.id).tier).toBe("normal");
    rig.clock.advance(1000);
    await rig.swarm.runMaintenance();
    const snap = rig.swarm.snapshot(agent.value.id);
    expect(snap.balanceUnits).toBe(parseUsd("0.20"));
    expect(snap.tier).toBe("critical");
    expect(snap.model).toBe("org/heretic-critical");
  });
});
