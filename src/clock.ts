export interface Clock {
  now(): number;
  advance(ms: number): void;
}

/** Wall clock plus an offset the owner can move in dry-run. Rent reads this, not the agent. */
export class OffsetClock implements Clock {
  offset = 0;

  now(): number {
    return Date.now() + this.offset;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error("Clock advances must be a non-negative number of milliseconds");
    }
    this.offset += Math.floor(ms);
  }
}

export class ManualClock implements Clock {
  constructor(private epoch: number) {}

  now(): number {
    return this.epoch;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error("Clock advances must be a non-negative number of milliseconds");
    }
    this.epoch += Math.floor(ms);
  }
}
