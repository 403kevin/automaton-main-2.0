import { afterEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseUsd } from "../src/money.js";
import { domainFor, TRANSFER_TYPES, verifyAuthorization } from "../src/x402.js";
import { harness } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("x402", () => {
  it("verifies a USDC transfer authorization signature", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const account = privateKeyToAccount(generatePrivateKey());
    const message = {
      from: account.address,
      to: rig.config.treasury,
      value: 1_000n,
      validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: `0x${"ab".repeat(32)}` as const,
    };
    const signature = await account.signTypedData({
      domain: domainFor(rig.config),
      types: TRANSFER_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
    });
    expect((await verifyAuthorization(rig.config, message, signature)).ok).toBe(true);
    const forged = await verifyAuthorization(rig.config, { ...message, value: 2_000n }, signature);
    expect(forged.ok).toBe(false);
  });

  it("moves dry-run USDC and credits only the seller", async () => {
    const rig = harness();
    cleanups.push(rig.cleanup);
    const seller = await rig.swarm.createAgent({ name: "seller" });
    const buyer = await rig.swarm.createAgent({ name: "buyer" });
    if (!seller.ok || !buyer.ok) throw new Error("create failed");
    rig.swarm.ownerTopup(seller.value.id, parseUsd("1"), "tool-money");
    const offered = await rig.swarm.handleTool(seller.value.id, {
      id: "offer-1",
      name: "offer_service",
      arguments: { priceUsd: "0.25", description: "A note from an AI.", body: "This answer was written by an AI agent." },
    });
    expect(offered.ok).toBe(true);
    await rig.swarm.simulateTransfer(buyer.value.id, "0x8888888888888888888888888888888888888888", parseUsd("1.00"), "fund-buyer");
    const paid = await rig.swarm.settleDryPayment(
      seller.value.id,
      `dryrun:${buyer.value.address}:${parseUsd("0.25")}:nonce12345`,
    );
    expect(paid.ok).toBe(true);
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits).toBe(parseUsd("1.25") - parseUsd("0.001"));
    expect(rig.swarm.snapshot(buyer.value.id).balanceUnits).toBe(parseUsd("0.75"));
    const again = await rig.swarm.settleDryPayment(
      seller.value.id,
      `dryrun:${buyer.value.address}:${parseUsd("0.25")}:nonce12345`,
    );
    expect(again.ok).toBe(false);
    const self = await rig.swarm.settleDryPayment(
      seller.value.id,
      `dryrun:${seller.value.address}:${parseUsd("0.25")}:nonce67890`,
    );
    expect(self.ok).toBe(false);
  });
});
