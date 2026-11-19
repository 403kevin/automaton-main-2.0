import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DryRunChain, FlakyChain, type ChainPort } from "../src/chain.js";
import { ManualClock } from "../src/clock.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { MockSearch, type SearchProvider } from "../src/search.js";
import type { SensesClient } from "../src/senses-client.js";
import { FakeRuntime } from "../src/runtime.js";
import { Swarm } from "../src/swarm.js";

export function harness(
  overrides: Record<string, string> = {},
  chain?: ChainPort,
  search?: SearchProvider,
  senses?: SensesClient,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-"));
  const config = loadConfig({
    DATA_DIR: dir,
    MONEY_MODE: "dry-run",
    NETWORK: "base-sepolia",
    WALLET_MASTER_KEY: "test-master-key-1234",
    ADMIN_TOKEN: "test-admin",
    TREASURY_ADDRESS: "0x1111111111111111111111111111111111111111",
    DAILY_RENT_USD: "1.00",
    RENT_INTERVAL_MS: "1000",
    GRACE_MS: "5000",
    NORMAL_MIN_USD: "1.00",
    LOW_MIN_USD: "0.25",
    AGENT_DAILY_CAP_USD: "2.00",
    GLOBAL_DAILY_CAP_USD: "3.00",
    MAX_POPULATION: "8",
    MAX_DEPTH: "2",
    MAX_CHILDREN: "3",
    CHILD_ENDOWMENT_USD: "1.00",
    REPLICATION_RESERVE_USD: "1.00",
    LLM_MODE: "mock",
    RUNTIME: "process",
    INFERENCE_RESERVE_USD: "0.01",
    DEFAULT_MODEL: "org/heretic-normal",
    LOW_COMPUTE_MODEL: "org/heretic-low",
    CRITICAL_MODEL: "org/heretic-critical",
    ...overrides,
  });
  const db = openDatabase(path.join(dir, "automaton.sqlite"));
  const clock = new ManualClock(1_700_000_000_000);
  const book = chain ?? new DryRunChain(db);
  const runtime = new FakeRuntime();
  const provider = search ?? new MockSearch();
  const swarm = new Swarm(db, config, clock, book, runtime, provider, undefined, senses);
  return {
    dir,
    config,
    db,
    clock,
    chain: book,
    runtime,
    swarm,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function flakyHarness() {
  return harness({}, new FlakyChain("rpc 500"));
}

export type Harness = ReturnType<typeof harness> & { config: AppConfig };
