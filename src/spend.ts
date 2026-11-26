export interface CapCheck {
  ok: boolean;
  reason?: string;
  /** The refusal rule ID (see refusals.ts); absent when the check passed or the amount was invalid. */
  rule?: string;
  /** When a spend cap blocked the call: hourly waits for the next UTC hour, daily for next UTC midnight. */
  retryScope?: "hourly" | "daily";
}

/** Milliseconds until the next UTC hour boundary after `now`. */
export function msUntilNextUtcHour(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1, 0, 0, 0);
  return Math.max(0, next - now);
}

/** Milliseconds until the next UTC midnight after `now`. */
export function msUntilNextUtcMidnight(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(0, next - now);
}

/** Start of the current UTC hour for `now`, as epoch ms. */
export function utcHourStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0, 0);
}

/** Caps apply to discretionary spend. Rent is outside this check and outside the agent's control. */
export function checkSpend(input: {
  amount: number;
  balance: number;
  agentSpent: number;
  globalSpent: number;
  agentCap: number;
  globalCap: number;
  killSwitch: boolean;
  allowNegative: boolean;
  /** Spend already booked in the current UTC hour. Ignored when agentHourlyCap is 0/undefined. */
  agentHourlySpent?: number;
  /** Per-agent hourly cap in micro-USD. 0 or undefined disables the hourly ceiling. */
  agentHourlyCap?: number;
}): CapCheck {
  if (input.amount < 0 || !Number.isSafeInteger(input.amount)) {
    return { ok: false, reason: "Spend amount is invalid." };
  }
  if (input.killSwitch && !input.allowNegative) {
    return { ok: false, reason: "Global kill switch is on. No LLM or on-chain spend is allowed.", rule: "kill_switch" };
  }
  if (!input.allowNegative && input.balance < input.amount) {
    return { ok: false, reason: "Balance is too low for this spend.", rule: "ledger.balance" };
  }
  const hourlyCap = input.agentHourlyCap ?? 0;
  if (!input.allowNegative && hourlyCap > 0 && (input.agentHourlySpent ?? 0) + input.amount > hourlyCap) {
    return {
      ok: false,
      reason: "Per-agent hourly spend cap would be exceeded. Discretionary spend is blocked until the next UTC hour.",
      rule: "spend.cap.hourly",
      retryScope: "hourly",
    };
  }
  if (!input.allowNegative && input.agentSpent + input.amount > input.agentCap) {
    return {
      ok: false,
      reason: "Per-agent daily spend cap would be exceeded.",
      rule: "spend.cap",
      retryScope: "daily",
    };
  }
  if (!input.allowNegative && input.globalSpent + input.amount > input.globalCap) {
    return {
      ok: false,
      reason: "Global daily spend cap would be exceeded.",
      rule: "spend.cap",
      retryScope: "daily",
    };
  }
  return { ok: true };
}
