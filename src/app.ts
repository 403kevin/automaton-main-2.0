import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runAgentLoop } from "./agent/loop.js";
import { DryRunChain, LiveChain } from "./chain.js";
import { OffsetClock } from "./clock.js";
import { loadConfig, type AppConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { DirectHost } from "./host.js";
import { InferenceGateway } from "./inference.js";
import { createLlm } from "./llm.js";
import { createSearch } from "./search.js";
import { LiveSettler } from "./settle.js";
import { Swarm } from "./swarm.js";
import { createRuntime, FakeRuntime } from "./runtime.js";

export interface AppContext {
  config: AppConfig;
  swarm: Swarm;
  host: DirectHost;
  clock: OffsetClock;
}

export async function buildApp(env: NodeJS.ProcessEnv): Promise<AppContext> {
  const dataDir = env.DATA_DIR ?? "data";
  fs.mkdirSync(dataDir, { recursive: true });
  const prepared = { ...env };
  if (!prepared.WALLET_MASTER_KEY || prepared.WALLET_MASTER_KEY.length < 16) {
    const file = path.join(dataDir, "master.key");
    if (fs.existsSync(file)) prepared.WALLET_MASTER_KEY = fs.readFileSync(file, "utf8").trim();
    else {
      const key = randomBytes(32).toString("hex");
      fs.writeFileSync(file, `${key}\n`, { mode: 0o600 });
      console.log(`Generated wallet master key at ${file}. The key is not shown.`);
      prepared.WALLET_MASTER_KEY = key;
    }
  }
  if (!prepared.ADMIN_TOKEN) {
    prepared.ADMIN_TOKEN = randomBytes(16).toString("hex");
    console.log(`Admin token (shown once): ${prepared.ADMIN_TOKEN}`);
  }
  const config = loadConfig(prepared);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(path.join(config.dataDir, "automaton.sqlite"));
  const clock = new OffsetClock();
  const chain = config.moneyMode === "live" ? new LiveChain(config) : new DryRunChain(db);
  const llm = createLlm(config);
  const search = createSearch(config);
  const swarm = new Swarm(db, config, clock, chain, new FakeRuntime(), search);
  if (config.moneyMode === "live") swarm.setSettler(new LiveSettler(config));
  const inference = new InferenceGateway(swarm, llm, config);
  swarm.setCouncil((agentId, question) => inference.council(agentId, question));
  const host = new DirectHost(swarm, inference);
  const runtime = await createRuntime(config, (spec, signal) => {
    void runAgentLoop({
      agentId: spec.id,
      host,
      signal,
      workspace: spec.workspace,
      denyHosts: config.denyHosts,
      sleepMs: config.turnIntervalMs,
    });
  });
  swarm.setRuntime(runtime);
  return { config, swarm, host, clock };
}
