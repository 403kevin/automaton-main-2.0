import { describe, expect, it } from "vitest";
import { sweepWithGas } from "../src/gas.js";

describe("sweep gas", () => {
  it("tops up ETH from the funder and only then moves USDC", async () => {
    const calls: string[] = [];
    const result = await sweepWithGas({
      usdc: async () => ({ ok: true, units: 1_000_000n }),
      eth: async () => ({ ok: true, units: 0n }),
      topUp: async (wei) => {
        calls.push(`topup:${wei}`);
        return { ok: true, units: wei, txHash: "0xgas" };
      },
      transfer: async (units) => {
        calls.push(`transfer:${units}`);
        return { ok: true, units, txHash: "0xusdc" };
      },
      minWei: 10n,
      topUpWei: 25n,
      funder: true,
    });
    expect(result.ok && result.txHash).toBe("0xusdc");
    expect(calls).toEqual(["topup:25", "transfer:1000000"]);
  });

  it("leaves USDC in place when the agent has no gas and no funder", async () => {
    let transferred = false;
    const result = await sweepWithGas({
      usdc: async () => ({ ok: true, units: 5n }),
      eth: async () => ({ ok: true, units: 0n }),
      topUp: async () => ({ ok: true, units: 1n }),
      transfer: async () => {
        transferred = true;
        return { ok: true, units: 5n };
      },
      minWei: 10n,
      topUpWei: 25n,
      funder: false,
    });
    expect(result.ok).toBe(false);
    expect(transferred).toBe(false);
    expect(result.error).toMatch(/GAS_FUNDER_PRIVATE_KEY/);
  });

  it("does not treat a failed ETH read as an empty wallet", async () => {
    let transferred = false;
    const result = await sweepWithGas({
      usdc: async () => ({ ok: true, units: 5n }),
      eth: async () => ({ ok: false, error: "rpc down" }),
      topUp: async () => ({ ok: true, units: 1n }),
      transfer: async () => {
        transferred = true;
        return { ok: true, units: 5n };
      },
      minWei: 10n,
      topUpWei: 25n,
      funder: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("rpc down");
    expect(transferred).toBe(false);
  });
});
