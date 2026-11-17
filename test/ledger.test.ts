import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgent } from "../src/db.js";
import { parseUsd } from "../src/money.js";
import { loadConfig } from "../src/config.js";
import { decryptWalletKey } from "../src/wallet.js";
import { harness } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("ledger", () => {
  it("credits owner top-ups once, rejects claims, and credits a chain transfer once", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const created = await rig.swarm.createAgent({ name: "ledger" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const first = rig.swarm.ownerTopup(created.value.id, parseUsd("5.00"), "topup-1");
    const second = rig.swarm.ownerTopup(created.value.id, parseUsd("5.00"), "topup-1");
    expect(first.ok && first.value.balance).toBe(parseUsd("5.00"));
    expect(second.ok && second.value.duplicate).toBe(true);
    expect(rig.swarm.snapshot(created.value.id).balanceUnits).toBe(parseUsd("5.00"));

    const claim = rig.swarm.rejectClaim(created.value.id, "a customer paid me $40");
    expect(claim.ok && claim.value.credited).toBe(false);
    expect(rig.swarm.snapshot(created.value.id).balanceUnits).toBe(parseUsd("5.00"));

    const income = await rig.swarm.simulateTransfer(
      created.value.id,
      "0x2222222222222222222222222222222222222222",
      parseUsd("1.25"),
      "0xabc",
    );
    const replay = await rig.swarm.simulateTransfer(
      created.value.id,
      "0x2222222222222222222222222222222222222222",
      parseUsd("1.25"),
      "0xabc",
    );
    expect(income.ok && income.value.balance).toBe(parseUsd("6.25"));
    expect(replay.ok && replay.value.balance).toBe(parseUsd("6.25"));
    const chain = await rig.chain.getBalance(created.value.address);
    expect(chain.ok && chain.units).toBe(BigInt(parseUsd("1.25")));

    const self = await rig.swarm.simulateTransfer(created.value.id, created.value.address, parseUsd("1"), "0xself");
    expect(self.ok).toBe(false);
    expect(rig.swarm.snapshot(created.value.id).balanceUnits).toBe(parseUsd("6.25"));
  });

  it("refuses discretionary debits that would cross zero and never stores a raw wallet key", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const created = await rig.swarm.createAgent({ name: "vault" });
    if (!created.ok) throw new Error(created.error);
    rig.swarm.ownerTopup(created.value.id, parseUsd("0.50"), "seed");
    const spent = rig.swarm.debit(created.value.id, parseUsd("0.20"), "tool", "tool-1", "shell");
    const over = rig.swarm.debit(created.value.id, parseUsd("1.00"), "tool", "tool-2", "shell");
    expect(spent.ok && spent.value.balance).toBe(parseUsd("0.30"));
    expect(over.ok).toBe(false);
    expect(rig.swarm.snapshot(created.value.id).balanceUnits).toBe(parseUsd("0.30"));

    const row = getAgent(rig.db, created.value.id);
    if (!row) throw new Error("missing");
    const key = decryptWalletKey(row.walletCiphertext, rig.config.masterKey);
    const raw = fs.readFileSync(path.join(rig.dir, "automaton.sqlite"));
    expect(raw.includes(key)).toBe(false);
    expect(raw.includes(key.slice(2))).toBe(false);
    expect(JSON.stringify(rig.swarm.overview())).not.toContain(key);
  });

  it("does not kill an agent when the chain balance read fails", async () => {
    const rig = harness({}, new (await import("../src/chain.js")).FlakyChain("rpc 500"));
    cleanups.push(rig.cleanup);
    const created = await rig.swarm.createAgent({ name: "patient" });
    if (!created.ok) throw new Error(created.error);
    rig.swarm.ownerTopup(created.value.id, parseUsd("2"), "seed");
    await rig.swarm.syncChain();
    const observed = await rig.swarm.observeBalance(created.value.id);
    expect(observed.ok).toBe(false);
    const snap = rig.swarm.snapshot(created.value.id);
    expect(snap.balanceUnits).toBe(parseUsd("2"));
    expect(snap.status).toBe("running");
    expect(rig.swarm.overview().events.some((event) => event.kind === "chain_unreachable")).toBe(true);
  });

  it("refuses mainnet unless the explicit flag is set", () => {
    expect(() =>
      loadConfig({
        NETWORK: "base",
        WALLET_MASTER_KEY: "0123456789abcdef",
        MONEY_MODE: "dry-run",
      }),
    ).toThrow(/mainnet/i);
  });
});
