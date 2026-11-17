export interface CapCheck {
  ok: boolean;
  reason?: string;
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
}): CapCheck {
  if (input.amount < 0 || !Number.isSafeInteger(input.amount)) {
    return { ok: false, reason: "Spend amount is invalid." };
  }
  if (input.killSwitch && !input.allowNegative) {
    return { ok: false, reason: "Global kill switch is on. No LLM or on-chain spend is allowed." };
  }
  if (!input.allowNegative && input.balance < input.amount) {
    return { ok: false, reason: "Balance is too low for this spend." };
  }
  if (!input.allowNegative && input.agentSpent + input.amount > input.agentCap) {
    return { ok: false, reason: "Per-agent daily spend cap would be exceeded." };
  }
  if (!input.allowNegative && input.globalSpent + input.amount > input.globalCap) {
    return { ok: false, reason: "Global daily spend cap would be exceeded." };
  }
  return { ok: true };
}
