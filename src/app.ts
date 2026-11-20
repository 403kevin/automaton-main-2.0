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
import { BrowseLlmProxy } from "./llm-proxy.js";
import { createLlm } from "./llm.js";
import { createSearch } from "./search.js";
import { LiveSettler } from "./settle.js";
import { Swarm } from "./swarm.js";
import { HandlerSandbox, handlerSnapshotRoot } from "./handlers.js";
import { createRuntime, detectDockerBinary, FakeRuntime } from "./runtime.js";
import { HttpUrlChecker, SandboxOfferVerifier } from "./verify-offer.js";

export interface AppContext {
  config: AppConfig;
  swarm: Swarm;
  host: DirectHost;
  clock: OffsetClock;
  handlers: HandlerSandbox;
  llmProxy: BrowseLlmProxy;
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
  const llmProxy = new BrowseLlmProxy({
    clock,
    openRouterUrl: config.openRouterUrl,
    openRouterKey: config.openRouterKey,
    allowCidrs: config.internalLlmAllowCidrs,
  });
  swarm.setBrowseLlm(llmProxy);
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
  const docker = await detectDockerBinary();
  const handlers = new HandlerSandbox({
    docker: docker ?? ["docker"],
    image: config.handlerImage,
    snapshotRoot: handlerSnapshotRoot(config.dataDir),
    dockerVolume: config.dockerVolume,
    timeoutMs: config.handlerTimeoutMs,
    queueTimeoutMs: config.handlerQueueTimeoutMs,
  });
  // The offer gate: a paid endpoint is test-run in the same sandbox that serves it, and outside URLs in offer text are checked.
  swarm.setOfferVerifier(new SandboxOfferVerifier(handlers));
  swarm.setUrlChecker(new HttpUrlChecker({ denyHosts: config.denyHosts }));
  return { config, swarm, host, clock, handlers, llmProxy };
}
