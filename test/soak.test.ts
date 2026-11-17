import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { loadConfig } from "../src/config.js";
import { parseUsd } from "../src/money.js";
import { loadEnvFile, SOAK_MODEL, SOAK_SEEDS } from "../src/soak.js";
import { harness } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("soak profile", () => {
  it("is a conservative 7-day Base Sepolia profile with three seeds and the listed uncensored model", () => {
    const env = loadEnvFile("config/soak.sepolia.env");
    expect(env.NETWORK).toBe("base-sepolia");
    expect(env.MONEY_MODE).toBe("live");
    expect(env.ALLOW_MAINNET).toBe("false");
    expect(env.DEFAULT_MODEL).toBe(SOAK_MODEL);
    expect(env.RENT_INTERVAL_MS).toBe("86400000");
    expect(env.REPORT_INTERVAL_MS).toBe("86400000");
    expect(env.SEARCH_PROVIDER).toBe("searxng");
    expect(SOAK_SEEDS).toHaveLength(3);
    const config = loadConfig({
      ...env,
      WALLET_MASTER_KEY: "test-master-key-1234",
      ADMIN_TOKEN: "test-admin-token",
      TREASURY_ADDRESS: "0x2222222222222222222222222222222222222222",
      OPENROUTER_API_KEY: "sk-or-test",
    });
    expect(config.network).toBe("base-sepolia");
    expect(config.moneyMode).toBe("live");
    expect(config.allowMainnet).toBe(false);
    expect(config.defaultModel).toBe(SOAK_MODEL);
    expect(config.agentDailyCapUnits).toBeLessThanOrEqual(parseUsd("0.50"));
    expect(config.globalDailyCapUnits).toBeLessThanOrEqual(parseUsd("1.00"));
    expect(config.facilitatorUrl).toBe("https://x402.org/facilitator");
    expect(config.turnIntervalMs).toBeGreaterThanOrEqual(60_000);
  });

  it("writes a daily report with alive, dead, income, and spend", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const alive = await rig.swarm.createAgent({ name: "mite" });
    const dead = await rig.swarm.createAgent({ name: "ash" });
    if (!alive.ok || !dead.ok) throw new Error("create failed");
    rig.swarm.ownerTopup(alive.value.id, parseUsd("2"), "seed");
    rig.clock.advance(1000);
    await rig.swarm.runMaintenance();
    rig.clock.advance(5000);
    await rig.swarm.runMaintenance();
    const report = rig.swarm.writeDailyReport();
    expect(report.markdown).toContain("Alive:");
    expect(report.markdown).toContain("Dead:");
    expect(report.markdown).toContain("income:");
    expect(report.markdown).toContain("spend:");
    expect(report.markdown).toContain("mite");
    expect(fs.existsSync(report.path)).toBe(true);
    expect(rig.swarm.overview().dailyReport).toContain("mite");
  });
});