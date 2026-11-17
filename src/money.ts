/** Integer micro-USD. 1_000_000 units = $1. Matches USDC's 6 decimals. */

export function parseUsd(input: string): number {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid USD amount "${input}". Use a positive number with at most 6 decimals.`);
  }
  const whole = Number(match[1]) * 1_000_000;
  const frac = Number((match[2] ?? "").padEnd(6, "0"));
  const units = whole + frac;
  if (!Number.isSafeInteger(units)) {
    throw new Error("Amount is too large");
  }
  return units;
}

export function formatUsd(units: number): string {
  const sign = units < 0 ? "-" : "";
  const abs = Math.abs(units);
  const whole = Math.floor(abs / 1_000_000);
  const frac = String(abs % 1_000_000).padStart(6, "0");
  const trimmed = frac.replace(/0+$/, "");
  const shown = trimmed.length < 2 ? frac.slice(0, 2) : trimmed;
  return `${sign}$${whole}.${shown}`;
}

export function dayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}
