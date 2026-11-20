import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress } from "viem";
import { selectHandlerImage } from "./handlers.js";
import { parseUsd } from "./money.js";

const DEFAULT_REDDIT_USER_AGENT = "AutomatonSenses/2.0 (key-free public JSON reader; no OAuth)";

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
  searchProvider: "auto" | "mock" | "duckduckgo" | "searxng" | "brave" | "tavily" | "exa";
  searxngUrl: string;
  braveSearchKey?: string;
  tavilyKey?: string;
  exaKey?: string;
  facilitatorKey?: `0x${string}`;
  facilitatorUrl: string;
  settlement: "auto" | "direct" | "facilitator";
  gasFunderKey?: `0x${string}`;
  gasMinWei: bigint;
  gasTopUpWei: bigint;
  reportIntervalMs: number;
  denyHosts: string[];
  turnIntervalMs: number;
  constitutionPath: string;
  sensesUrl: string;
  seePagePriceUnits: number;
  seePageScreenshotPriceUnits: number;
  seePageHourlyLimit: number;
  crawlPagePriceUnits: number;
  crawlHourlyLimit: number;
  crawlMaxPages: number;
  readFeedPriceUnits: number;
  readFeedHourlyLimit: number;
  claimHourlyLimit: number;
  redditUserAgent: string;
  browseEnabled: boolean;
  browseStepPriceUnits: number;
  browseLlmReserveUnits: number;
  browseHourlyLimit: number;
  browseMaxSteps: number;
  sensesLlmBaseUrl: string;
  internalLlmPort: number;
  internalLlmHost: string;
  internalLlmAllowCidrs: string[];
  refDir: string;
  publishPagePriceUnits: number;
  serveEndpointPriceUnits: number;
  serveMinPriceUnits: number;
  serveMaxPriceUnits: number;
  handlerTimeoutMs: number;
  handlerQueueTimeoutMs: number;
  offerRetestIntervalMs: number;
  offerCheckHourlyLimit: number;
  handlerImage: string;
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

function atLeast(value: string | undefined, fallback: number, min: number, name: string): number {
  const parsed = integer(value, fallback, name);
  if (parsed < min) throw new Error(`${name} must be at least ${min}.`);
  return parsed;
}

function privateKey(value: string | undefined, name: string): `0x${string}` | undefined {
  if (!value) return undefined;
  const prefixed = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(prefixed)) {
    throw new Error(`${name} must be a 32-byte hex private key.`);
  }
  return prefixed as `0x${string}`;
}

function wei(value: string | undefined, fallback: bigint, name: string): bigint {
  if (!value) return fallback;
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new Error(`${name} must be a non-negative integer number of wei.`);
  }
}

function headerValue(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").replace(/[\r\n]/g, "").trim();
  return cleaned || fallback;
}

function defaultRefDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ref");
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
  const searchRaw = env.SEARCH_PROVIDER ?? "auto";
  if (!["auto", "mock", "duckduckgo", "searxng", "brave", "tavily", "exa"].includes(searchRaw)) {
    throw new Error("SEARCH_PROVIDER must be auto, mock, duckduckgo, searxng, brave, tavily, or exa.");
  }
  const settlementRaw = env.X402_SETTLEMENT ?? "auto";
  if (settlementRaw !== "auto" && settlementRaw !== "direct" && settlementRaw !== "facilitator") {
    throw new Error("X402_SETTLEMENT must be auto, direct, or facilitator.");
  }
  const facilitatorKey = privateKey(env.FACILITATOR_PRIVATE_KEY, "FACILITATOR_PRIVATE_KEY");
  const gasFunderKey = privateKey(env.GAS_FUNDER_PRIVATE_KEY, "GAS_FUNDER_PRIVATE_KEY") ?? facilitatorKey;
  let facilitatorUrl = env.X402_FACILITATOR_URL ?? "";
  if (!facilitatorUrl && moneyMode === "live" && network === "base-sepolia" && settlementRaw !== "direct") {
    facilitatorUrl = "https://x402.org/facilitator";
  }
  if (moneyMode === "live" && network === "base" && settlementRaw === "facilitator" && !env.X402_FACILITATOR_URL) {
    throw new Error("Mainnet facilitator settlement requires an explicit X402_FACILITATOR_URL.");
  }
  const normalMin = usd(env.NORMAL_MIN_USD, "1.00", "NORMAL_MIN_USD");
  const lowMin = usd(env.LOW_MIN_USD, "0.25", "LOW_MIN_USD");
  if (lowMin > normalMin) {
    throw new Error("LOW_MIN_USD cannot be above NORMAL_MIN_USD.");
  }
  const serveMinPriceUnits = usd(env.SERVE_MIN_PRICE_USD, "0.001", "SERVE_MIN_PRICE_USD");
  const serveMaxPriceUnits = usd(env.SERVE_MAX_PRICE_USD, "1.00", "SERVE_MAX_PRICE_USD");
  if (serveMinPriceUnits <= 0) throw new Error("SERVE_MIN_PRICE_USD must be positive.");
  if (serveMaxPriceUnits < serveMinPriceUnits) {
    throw new Error("SERVE_MAX_PRICE_USD cannot be below SERVE_MIN_PRICE_USD.");
  }
  const agentImage = env.AGENT_IMAGE ?? "automaton:2";
  const publishPagePriceUnits = usd(env.PUBLISH_PAGE_PRICE_USD, "0.001", "PUBLISH_PAGE_PRICE_USD");
  const serveEndpointPriceUnits = usd(env.SERVE_ENDPOINT_PRICE_USD, "0.002", "SERVE_ENDPOINT_PRICE_USD");
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
    agentImage,
    orchestratorUrl: env.ORCHESTRATOR_URL ?? "http://orchestrator:4747",
    searchProvider: searchRaw as AppConfig["searchProvider"],
    searxngUrl: env.SEARXNG_URL ?? "",
    braveSearchKey: env.BRAVE_SEARCH_API_KEY,
    tavilyKey: env.TAVILY_API_KEY,
    exaKey: env.EXA_API_KEY,
    facilitatorKey,
    facilitatorUrl,
    settlement: settlementRaw,
    gasFunderKey,
    gasMinWei: wei(env.GAS_MIN_WEI, 20_000_000_000_000n, "GAS_MIN_WEI"),
    gasTopUpWei: wei(env.GAS_TOPUP_WEI, 50_000_000_000_000n, "GAS_TOPUP_WEI"),
    reportIntervalMs: integer(env.REPORT_INTERVAL_MS, 86_400_000, "REPORT_INTERVAL_MS"),
    denyHosts: (env.OWNER_DENY_HOSTS ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
    turnIntervalMs: integer(env.TURN_INTERVAL_MS, 15_000, "TURN_INTERVAL_MS"),
    constitutionPath: env.CONSTITUTION_PATH ?? "constitution.md",
    sensesUrl: env.SENSES_URL || "http://senses:7070",
    seePagePriceUnits: usd(env.SEE_PAGE_PRICE_USD, "0.002", "SEE_PAGE_PRICE_USD"),
    seePageScreenshotPriceUnits: usd(env.SEE_PAGE_SCREENSHOT_PRICE_USD, "0.003", "SEE_PAGE_SCREENSHOT_PRICE_USD"),
    seePageHourlyLimit: integer(env.SEE_PAGE_HOURLY_LIMIT, 30, "SEE_PAGE_HOURLY_LIMIT"),
    crawlPagePriceUnits: usd(env.CRAWL_PAGE_PRICE_USD, "0.001", "CRAWL_PAGE_PRICE_USD"),
    crawlHourlyLimit: integer(env.CRAWL_HOURLY_LIMIT, 5, "CRAWL_HOURLY_LIMIT"),
    crawlMaxPages: integer(env.CRAWL_MAX_PAGES, 20, "CRAWL_MAX_PAGES"),
    readFeedPriceUnits: usd(env.READ_FEED_PRICE_USD, "0.0005", "READ_FEED_PRICE_USD"),
    readFeedHourlyLimit: integer(env.READ_FEED_HOURLY_LIMIT, 60, "READ_FEED_HOURLY_LIMIT"),
    claimHourlyLimit: integer(env.CLAIM_HOURLY_LIMIT, 30, "CLAIM_HOURLY_LIMIT"),
    redditUserAgent: headerValue(env.REDDIT_USER_AGENT, DEFAULT_REDDIT_USER_AGENT),
    browseEnabled: env.BROWSE_ENABLED === "true",
    browseStepPriceUnits: usd(env.BROWSE_STEP_PRICE_USD, "0.005", "BROWSE_STEP_PRICE_USD"),
    browseLlmReserveUnits: usd(env.BROWSE_LLM_RESERVE_USD, "0.05", "BROWSE_LLM_RESERVE_USD"),
    browseHourlyLimit: integer(env.BROWSE_HOURLY_LIMIT, 3, "BROWSE_HOURLY_LIMIT"),
    browseMaxSteps: Math.min(15, Math.max(1, integer(env.BROWSE_MAX_STEPS, 15, "BROWSE_MAX_STEPS"))),
    sensesLlmBaseUrl:
      env.SENSES_LLM_BASE_URL ||
      `http://127.0.0.1:${integer(env.INTERNAL_LLM_PORT, 4758, "INTERNAL_LLM_PORT")}/internal/llm/v1`,
    internalLlmPort: integer(env.INTERNAL_LLM_PORT, 4758, "INTERNAL_LLM_PORT"),
    internalLlmHost: (env.INTERNAL_LLM_HOST || "127.0.0.1").trim(),
    internalLlmAllowCidrs: (env.INTERNAL_LLM_ALLOW_CIDRS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    refDir: path.resolve(env.REF_DIR && env.REF_DIR.trim() ? env.REF_DIR : defaultRefDir()),
    publishPagePriceUnits,
    serveEndpointPriceUnits,
    serveMinPriceUnits,
    serveMaxPriceUnits,
    handlerTimeoutMs: atLeast(env.HANDLER_TIMEOUT_MS, 10_000, 1, "HANDLER_TIMEOUT_MS"),
    handlerQueueTimeoutMs: atLeast(env.HANDLER_QUEUE_TIMEOUT_MS, 10_000, 1, "HANDLER_QUEUE_TIMEOUT_MS"),
    offerRetestIntervalMs: atLeast(env.OFFER_RETEST_INTERVAL_MS, 21_600_000, 1, "OFFER_RETEST_INTERVAL_MS"),
    offerCheckHourlyLimit: integer(env.OFFER_CHECK_HOURLY_LIMIT, 20, "OFFER_CHECK_HOURLY_LIMIT"),
    handlerImage:
      (env.HANDLER_IMAGE ?? "").trim() || selectHandlerImage(agentImage, env.AGENT_IMAGE_HAS_NODE !== "false"),
    toolCosts: {
      shell: parseUsd("0.001"),
      fetch_url: parseUsd("0.001"),
      web_search: usd(env.SEARCH_COST_USD, "0.002", "SEARCH_COST_USD"),
      see_page: usd(env.SEE_PAGE_PRICE_USD, "0.002", "SEE_PAGE_PRICE_USD"),
      crawl_site: usd(env.CRAWL_PAGE_PRICE_USD, "0.001", "CRAWL_PAGE_PRICE_USD"),
      read_feed: usd(env.READ_FEED_PRICE_USD, "0.0005", "READ_FEED_PRICE_USD"),
      browse: 0,
      write_file: parseUsd("0.0001"),
      read_file: parseUsd("0.0001"),
      offer_service: parseUsd("0.001"),
      publish_page: publishPagePriceUnits,
      serve_endpoint: serveEndpointPriceUnits,
      remember: parseUsd("0.0001"),
      claim: usd(env.CLAIM_COST_USD, "0.0001", "CLAIM_COST_USD"),
      balance: 0,
      council: 0,
      spawn_child: 0,
      pay_request: 0,
    },
  };
}
