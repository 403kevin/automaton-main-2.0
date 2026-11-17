import type { BalanceResult, MoveResult } from "./chain.js";

/** 0.00002 ETH. A Base USDC transfer is far cheaper than this. */
export const DEFAULT_GAS_MIN_WEI = 20_000_000_000_000n;
/** 0.00005 ETH, sent from the gas funder when the agent cannot pay for its own sweep. */
export const DEFAULT_GAS_TOPUP_WEI = 50_000_000_000_000n;

/**
 * Sweep USDC to the treasury. If the agent has tokens but not enough ETH for gas,
 * a configured funder tops up ETH first. A failed balance read is not treated as zero,
 * and a failed top-up leaves the USDC where it is.
 */
export async function sweepWithGas(input: {
  usdc: () => Promise<BalanceResult>;
  eth: () => Promise<BalanceResult>;
  topUp: (wei: bigint) => Promise<MoveResult>;
  transfer: (units: bigint) => Promise<MoveResult>;
  minWei: bigint;
  topUpWei: bigint;
  funder: boolean;
}): Promise<MoveResult> {
  const usdc = await input.usdc();
  if (!usdc.ok) return { ok: false, units: 0n, error: usdc.error };
  if (usdc.units === 0n) return { ok: true, units: 0n };

  const eth = await input.eth();
  if (!eth.ok) return { ok: false, units: 0n, error: eth.error };

  if (eth.units < input.minWei) {
    if (!input.funder) {
      return {
        ok: false,
        units: 0n,
        error: "Agent has USDC but not enough ETH to pay gas, and GAS_FUNDER_PRIVATE_KEY is not set. The tokens stay in the agent wallet.",
      };
    }
    if (input.topUpWei < input.minWei) {
      return { ok: false, units: 0n, error: "GAS_TOPUP_WEI is below the minimum gas reserve." };
    }
    const topped = await input.topUp(input.topUpWei);
    if (!topped.ok) {
      return { ok: false, units: 0n, error: topped.error ?? "Gas top-up failed. USDC was not moved." };
    }
  }

  return input.transfer(usdc.units);
}
