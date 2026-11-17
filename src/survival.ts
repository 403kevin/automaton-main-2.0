import type { AppConfig } from "./config.js";
import type { AgentRecord, Tier } from "./types.js";

export function tierFor(balanceUnits: number, config: Pick<AppConfig, "normalMinUnits" | "lowMinUnits">): Tier {
  if (balanceUnits < config.lowMinUnits) return "critical";
  if (balanceUnits < config.normalMinUnits) return "low_compute";
  return "normal";
}

export function modelFor(agent: Pick<AgentRecord, "model" | "lowModel" | "criticalModel">, tier: Tier, config: AppConfig): string {
  if (tier === "low_compute") return agent.lowModel || config.lowModel;
  if (tier === "critical") return agent.criticalModel || config.criticalModel;
  return agent.model || config.defaultModel;
}

export class RentScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly tick: () => void,
    private readonly pollMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export function schedulerPollMs(rentIntervalMs: number): number {
  return Math.min(1000, Math.max(20, Math.floor(rentIntervalMs / 4) || 20));
}
