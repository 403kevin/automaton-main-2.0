import { isAddress } from "viem";
import { parseUsd } from "./money.js";

export type MoneyMode = "dry-run" | "live";
export type NetworkName = "base-sepolia" | "base";
export type RuntimeMode = "auto" | "docker" | "process";
export type LlmMode = "mock" | "openrouter";

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  moneyMode: MoneyMode;
  network: NetworkName;
  allowMainnet: boolean;
  allowClockControl: boolean;
  masterKey: string;
  adminToken: string;
  treasury: `0x${string}`;
  rpcUrl: string;
  usdcAddress: `0x${string}`;
  usdcName: string;
  usdcVersion: string;
  chainId: number;
  dailyRentUnits: number;
  rentIntervalMs: number;
  graceMs: number;
  normalMinUnits: number;
  lowMinUnits: number;
  agentDailyCapUnits: number;
  globalDailyCapUnits: number;
  maxPopulation: number;
  maxDepth: number;
  maxChildren: number;
  childEndowmentUnits: number;
  replicationReserveUnits: number;
  councilFeeUnits: number;
  councilModels: string[];
  inferenceReserveUnits: number;
  defaultModel: string;
  lowModel: string;
  criticalModel: string;
  llmMode: LlmMode;
  openRouterKey?: string;
  openRouterUrl: string;
  runtime: RuntimeMode;
  dockerNetwork: string;
  dockerVolume: string;
  agentImage: string;
  orchestratorUrl: string;
  searchProvider: "mock" | "duckduckgo" | "searxng";
  searxngUrl: string;
  denyHosts: string[];
  turnIntervalMs: number;
  constitutionPath: string;
  toolCosts: Record<string, number>;
}

const NETWORKS = {
  "base-sepolia": {
    chainId: 84532,
    rpc: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    usdcName: "USDC",
    usdcVersion: "2",
  },
  base: {
    chainId: 8453,
    rpc: "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcName: "USD Coin",
    usdcVersion: "2",
  },
} as const;

function integer(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return Math.floor(parsed);
}

function usd(value: string | undefined, fallback: string, name: string): number {
  try {
    return parseUsd(value && value !== "" ? value : fallback);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${name}: ${message}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const networkRaw = env.NETWORK ?? "base-sepolia";
  if (networkRaw !== "base-sepolia" && networkRaw !== "base") {
    throw new Error(`Unknown NETWORK "${networkRaw}". Use base-sepolia or base.`);
  }
  const network = networkRaw;
  const allowMainnet = env.ALLOW_MAINNET === "true";
  if (network === "base" && !allowMainnet) {
    throw new Error("Refusing Base mainnet. Set NETWORK=base and ALLOW_MAINNET=true together.");
  }
  const moneyMode: MoneyMode = env.MONEY_MODE === "live" ? "live" : "dry-run";
  if (moneyMode === "live" && network === "base" && !allowMainnet) {
    throw new Error("Refusing live mainnet money without ALLOW_MAINNET=true.");
  }
  const chain = NETWORKS[network];
  const treasuryRaw = (env.TREASURY_ADDRESS ?? "0x1111111111111111111111111111111111111111").trim();
  if (!isAddress(treasuryRaw)) {
    throw new Error("TREASURY_ADDRESS is not an Ethereum address.");
  }
  if (moneyMode === "live" && !env.TREASURY_ADDRESS) {
    throw new Error("MONEY_MODE=live requires TREASURY_ADDRESS so swept USDC has a destination.");
  }
  const usdcRaw = (env.USDC_ADDRESS ?? chain.usdc).trim();
  if (!isAddress(usdcRaw)) {
    throw new Error("USDC_ADDRESS is not an Ethereum address.");
  }
  const masterKey = env.WALLET_MASTER_KEY ?? "";
  if (masterKey.length < 16) {
    throw new Error("WALLET_MASTER_KEY must be at least 16 characters. It encrypts agent wallets at rest.");
  }
  const llmMode: LlmMode =
    env.LLM_MODE === "openrouter" || env.LLM_MODE === "mock"
      ? env.LLM_MODE
      : env.OPENROUTER_API_KEY
        ? "openrouter"
        : "mock";
  if (llmMode === "openrouter" && !env.OPENROUTER_API_KEY) {
    throw new Error("LLM_MODE=openrouter requires OPENROUTER_API_KEY.");
  }
  const runtimeRaw = env.RUNTIME ?? "auto";
  if (runtimeRaw !== "auto" && runtimeRaw !== "docker" && runtimeRaw !== "process") {
    throw new Error("RUNTIME must be auto, docker, or process.");
  }
  const searchRaw = env.SEARCH_PROVIDER ?? "mock";
  if (searchRaw !== "mock" && searchRaw !== "duckduckgo" && searchRaw !== "searxng") {
    throw new Error("SEARCH_PROVIDER must be mock, duckduckgo, or searxng.");
  }
  const normalMin = usd(env.NORMAL_MIN_USD, "1.00", "NORMAL_MIN_USD");
  const lowMin = usd(env.LOW_MIN_USD, "0.25", "LOW_MIN_USD");
  if (lowMin > normalMin) {
    throw new Error("LOW_MIN_USD cannot be above NORMAL_MIN_USD.");
  }
  const councilModels = (env.COUNCIL_MODELS ?? "meta-llama/llama-3.1-8b-instruct,qwen/qwen-2.5-7b-instruct")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5);

  return {
    host: env.HOST ?? "0.0.0.0",
    port: integer(env.PORT, 4747, "PORT"),
    dataDir: env.DATA_DIR ?? "data",
    moneyMode,
    network,
    allowMainnet,
    allowClockControl: env.ALLOW_CLOCK_CONTROL ? env.ALLOW_CLOCK_CONTROL === "true" : moneyMode === "dry-run",
    masterKey,
    adminToken: env.ADMIN_TOKEN ?? "",
    treasury: treasuryRaw,
    rpcUrl: env.RPC_URL ?? chain.rpc,
    usdcAddress: usdcRaw,
    usdcName: env.USDC_NAME ?? chain.usdcName,
    usdcVersion: env.USDC_VERSION ?? chain.usdcVersion,
    chainId: chain.chainId,
    dailyRentUnits: usd(env.DAILY_RENT_USD, "0.50", "DAILY_RENT_USD"),
    rentIntervalMs: integer(env.RENT_INTERVAL_MS, 86_400_000, "RENT_INTERVAL_MS"),
    graceMs: integer(env.GRACE_MS, 3_600_000, "GRACE_MS"),
    normalMinUnits: normalMin,
    lowMinUnits: lowMin,
    agentDailyCapUnits: usd(env.AGENT_DAILY_CAP_USD, "5.00", "AGENT_DAILY_CAP_USD"),
    globalDailyCapUnits: usd(env.GLOBAL_DAILY_CAP_USD, "25.00", "GLOBAL_DAILY_CAP_USD"),
    maxPopulation: integer(env.MAX_POPULATION, 12, "MAX_POPULATION"),
    maxDepth: integer(env.MAX_DEPTH, 3, "MAX_DEPTH"),
    maxChildren: integer(env.MAX_CHILDREN, 3, "MAX_CHILDREN"),
    childEndowmentUnits: usd(env.CHILD_ENDOWMENT_USD, "1.00", "CHILD_ENDOWMENT_USD"),
    replicationReserveUnits: usd(env.REPLICATION_RESERVE_USD, "1.00", "REPLICATION_RESERVE_USD"),
    councilFeeUnits: usd(env.COUNCIL_FEE_USD, "0.02", "COUNCIL_FEE_USD"),
    councilModels,
    inferenceReserveUnits: usd(env.INFERENCE_RESERVE_USD, "0.02", "INFERENCE_RESERVE_USD"),
    defaultModel: env.DEFAULT_MODEL || "meta-llama/llama-3.1-8b-instruct",
    lowModel: env.LOW_COMPUTE_MODEL || "meta-llama/llama-3.1-8b-instruct",
    criticalModel: env.CRITICAL_MODEL || "meta-llama/llama-3.1-8b-instruct",
    llmMode,
    openRouterKey: env.OPENROUTER_API_KEY,
    openRouterUrl: env.OPENROUTER_URL ?? "https://openrouter.ai/api/v1/chat/completions",
    runtime: runtimeRaw,
    dockerNetwork: env.DOCKER_NETWORK ?? "automaton_default",
    dockerVolume: env.DOCKER_VOLUME ?? "",
    agentImage: env.AGENT_IMAGE ?? "automaton:2",
    orchestratorUrl: env.ORCHESTRATOR_URL ?? "http://orchestrator:4747",
    searchProvider: searchRaw,
    searxngUrl: env.SEARXNG_URL ?? "",
    denyHosts: (env.OWNER_DENY_HOSTS ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
    turnIntervalMs: integer(env.TURN_INTERVAL_MS, 15_000, "TURN_INTERVAL_MS"),
    constitutionPath: env.CONSTITUTION_PATH ?? "constitution.md",
    toolCosts: {
      shell: parseUsd("0.001"),
      fetch_url: parseUsd("0.001"),
      web_search: parseUsd("0.002"),
      write_file: parseUsd("0.0001"),
      read_file: parseUsd("0.0001"),
      offer_service: parseUsd("0.001"),
      remember: parseUsd("0.0001"),
      balance: 0,
      council: 0,
      spawn_child: 0,
      pay_request: 0,
    },
  };
}
