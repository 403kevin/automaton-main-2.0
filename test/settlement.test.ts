import { afterEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseUsd } from "../src/money.js";
import { encodePaymentHeader, interpretFacilitatorSettle, signAuthorization, type PaymentSettler } from "../src/x402.js";
import { harness } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

class ScriptedSettler implements PaymentSettler {
  calls = 0;
  constructor(private readonly results: Array<{ ok: true; txHash: string } | { ok: false; error: string }>) {}
  async settle(): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
    const next = this.results[this.calls++] ?? { ok: false as const, error: "no scripted result" };
    return next;
  }
}

describe("x402 settlement", () => {
  it("credits the ledger only after a confirmed settlement and ignores a replay", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const seller = await rig.swarm.createAgent({ name: "till" });
    if (!seller.ok) throw new Error(seller.error);
    rig.swarm.ownerTopup(seller.value.id, parseUsd("1"), "tools");
    const offered = await rig.swarm.handleTool(seller.value.id, {
      id: "offer-settle",
      name: "offer_service",
      arguments: { priceUsd: "0.25", description: "A note from an AI.", body: "Written by an AI agent." },
    });
    expect(offered.ok).toBe(true);
    const payerKey = generatePrivateKey();
    const payer = privateKeyToAccount(payerKey);
    const message = {
      from: payer.address,
      to: seller.value.address as `0x${string}`,
      value: BigInt(parseUsd("0.25")),
      validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: `0x${"cd".repeat(32)}` as const,
    };
    const signature = await signAuthorization(payerKey, rig.config, message);
    const header = encodePaymentHeader({
      config: rig.config,
      message,
      signature,
      resource: `/a/${seller.value.id}`,
      description: "A note from an AI.",
    });
    const settler = new ScriptedSettler([
      { ok: false, error: "reverted" },
      { ok: true, txHash: `0x${"ab".repeat(32)}` },
    ]);
    rig.swarm.setSettler(settler);
    const before = rig.swarm.snapshot(seller.value.id).balanceUnits;
    const rejected = await rig.swarm.settleDryPayment(seller.value.id, header);
    expect(rejected.ok).toBe(false);
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits).toBe(before);
    expect(settler.calls).toBe(1);

    const paid = await rig.swarm.settleDryPayment(seller.value.id, header);
    expect(paid.ok).toBe(true);
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits - before).toBe(parseUsd("0.25"));
    expect(settler.calls).toBe(2);

    const replay = await rig.swarm.settleDryPayment(seller.value.id, header);
    expect(replay.ok).toBe(false);
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits - before).toBe(parseUsd("0.25"));
    expect(settler.calls).toBe(2);
  });

  it("does not call the settler when the signature does not match", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const seller = await rig.swarm.createAgent({ name: "gate" });
    if (!seller.ok) throw new Error(seller.error);
    rig.swarm.ownerTopup(seller.value.id, parseUsd("1"), "tools");
    await rig.swarm.handleTool(seller.value.id, {
      id: "offer-bad",
      name: "offer_service",
      arguments: { priceUsd: "0.10", description: "AI note.", body: "An AI wrote this." },
    });
    const payerKey = generatePrivateKey();
    const payer = privateKeyToAccount(payerKey);
    const message = {
      from: payer.address,
      to: seller.value.address as `0x${string}`,
      value: BigInt(parseUsd("0.10")),
      validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: `0x${"ef".repeat(32)}` as const,
    };
    const signature = await signAuthorization(payerKey, rig.config, message);
    const broken = (`${signature.slice(0, -1)}${signature.endsWith("a") ? "b" : "a"}`) as `0x${string}`;
    const header = encodePaymentHeader({
      config: rig.config,
      message,
      signature: broken,
      resource: `/a/${seller.value.id}`,
      description: "AI note.",
    });
    const settler = new ScriptedSettler([{ ok: true, txHash: `0x${"11".repeat(32)}` }]);
    rig.swarm.setSettler(settler);
    const result = await rig.swarm.settleDryPayment(seller.value.id, header);
    expect(result.ok).toBe(false);
    expect(settler.calls).toBe(0);
  });

  it("treats a facilitator success without a transaction hash as unconfirmed", () => {
    expect(interpretFacilitatorSettle({ success: true }).ok).toBe(false);
    expect(interpretFacilitatorSettle({ success: false, errorReason: "insufficient_funds" }).ok).toBe(false);
    const ok = interpretFacilitatorSettle({ success: true, transaction: `0x${"22".repeat(32)}` });
    expect(ok.ok && ok.txHash).toBe(`0x${"22".repeat(32)}`);
  });
});
