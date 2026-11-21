import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseUsd } from "../src/money.js";
import { loadEnvFile } from "../src/soak.js";

// specs/BO-3.1a-soak-profile-keys.md: both soak profiles list every setting, and a missing one fails here.

const TEMPLATE = "config/soak.env.template";
const SEPOLIA = "config/soak.sepolia.env";
const EXAMPLE = ".env.example";

/** In the example file, unused by the SearXNG soak, or filled by a network or path default. */
const NOT_IN_SOAK: Record<string, string> = {
  BRAVE_SEARCH_API_KEY: "unused with SearXNG",
  TAVILY_API_KEY: "unused with SearXNG",
  EXA_API_KEY: "unused with SearXNG",
  USDC_ADDRESS: "network default",
  HANDLER_IMAGE: "defaults to AGENT_IMAGE",
};

/** Read by config.ts and set by compose, or a fixed path. Not an owner soak setting. */
const INTERNAL: Record<string, string> = {
  AGENT_IMAGE_HAS_NODE: "compose chooses the handler image; not a soak setting",
  CONSTITUTION_PATH: "default constitution.md; not a soak setting",
  INTERNAL_LLM_ALLOW_CIDRS: "set by compose environment",
  INTERNAL_LLM_HOST: "set by compose environment",
  INTERNAL_LLM_PORT: "set by compose environment",
  SENSES_LLM_BASE_URL: "set by compose environment",
};

const WRITTEN = [
  "CLAIM_COST_USD",
  "CLAIM_HOURLY_LIMIT",
  "PREDICT_COST_USD",
  "PREDICT_HOURLY_LIMIT",
  "OFFER_RETEST_INTERVAL_MS",
  "OFFER_CHECK_HOURLY_LIMIT",
  "ALLOW_CLOCK_CONTROL",
  "OWNER_DENY_HOSTS",
] as const;

/** Keys the template had that soak.sepolia.env did not. */
const SEPOLIA_GAP = [
  "SENSES_URL",
  "SEE_PAGE_PRICE_USD",
  "SEE_PAGE_SCREENSHOT_PRICE_USD",
  "SEE_PAGE_HOURLY_LIMIT",
  "CRAWL_PAGE_PRICE_USD",
  "CRAWL_HOURLY_LIMIT",
  "CRAWL_MAX_PAGES",
  "READ_FEED_PRICE_USD",
  "READ_FEED_HOURLY_LIMIT",
  "REDDIT_USER_AGENT",
  "BROWSE_ENABLED",
  "BROWSE_STEP_PRICE_USD",
  "BROWSE_LLM_RESERVE_USD",
  "BROWSE_HOURLY_LIMIT",
  "BROWSE_MAX_STEPS",
  "PUBLISH_PAGE_PRICE_USD",
  "SERVE_ENDPOINT_PRICE_USD",
  "SERVE_MIN_PRICE_USD",
  "SERVE_MAX_PRICE_USD",
  "HANDLER_TIMEOUT_MS",
  "HANDLER_QUEUE_TIMEOUT_MS",
  "CONSTITUTION_DENY_HOSTS",
] as const;

const SECRETS = {
  WALLET_MASTER_KEY: "test-master-key-1234",
  ADMIN_TOKEN: "test-admin-token",
  TREASURY_ADDRESS: "0x2222222222222222222222222222222222222222",
  OPENROUTER_API_KEY: "sk-or-test",
};

function read(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/** Assignment keys and commented `# KEY=` keys. */
function declaredKeys(file: string): Set<string> {
  const keys = new Set<string>();
  for (const line of read(file).split("\n")) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match?.[1]) keys.add(match[1]);
  }
  return keys;
}

function namesReadByConfig(): Set<string> {
  const names = new Set<string>();
  for (const match of read("src/config.ts").matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

describe("soak profiles carry every setting", () => {
  it("puts every .env.example key in the template, or excuses it", () => {
    const template = declaredKeys(TEMPLATE);
    const missing: string[] = [];
    for (const key of declaredKeys(EXAMPLE)) {
      if (template.has(key) || NOT_IN_SOAK[key]) continue;
      missing.push(key);
    }
    expect(missing, missing.join(", ")).toEqual([]);
  });

  it("writes the claim, predict, offer, clock and deny-host settings in both profiles", () => {
    for (const file of [TEMPLATE, SEPOLIA]) {
      const env = loadEnvFile(file);
      for (const key of WRITTEN) expect(env[key], `${file} ${key}`).toBeDefined();
    }
  });

  it("gives the Sepolia profile every template key, including the 22 that were only in the template", () => {
    const template = loadEnvFile(TEMPLATE);
    const sepolia = loadEnvFile(SEPOLIA);
    const gaps = SEPOLIA_GAP.filter((key) => sepolia[key] !== template[key]);
    expect(gaps, gaps.join(", ")).toEqual([]);
    expect(Object.keys(sepolia).sort()).toEqual(Object.keys(template).sort());
  });

  it("agrees on every value except MONEY_MODE", () => {
    const template = loadEnvFile(TEMPLATE);
    const sepolia = loadEnvFile(SEPOLIA);
    expect(template.MONEY_MODE).toBe("dry-run");
    expect(sepolia.MONEY_MODE).toBe("live");
    for (const key of Object.keys(template)) {
      if (key === "MONEY_MODE") continue;
      expect(sepolia[key], key).toBe(template[key]);
    }
  });

  it("puts every name config.ts reads in .env.example, or excuses it as internal", () => {
    const example = declaredKeys(EXAMPLE);
    const missing: string[] = [];
    for (const name of namesReadByConfig()) {
      if (example.has(name) || INTERNAL[name]) continue;
      missing.push(name);
    }
    expect(missing.sort(), missing.join(", ")).toEqual([]);
  });

  it("loads the six written values from each profile", () => {
    for (const file of [TEMPLATE, SEPOLIA]) {
      const config = loadConfig({ ...loadEnvFile(file), ...SECRETS });
      expect(config.toolCosts.claim, file).toBe(parseUsd("0.0001"));
      expect(config.claimHourlyLimit, file).toBe(30);
      expect(config.toolCosts.predict, file).toBe(parseUsd("0.0001"));
      expect(config.predictHourlyLimit, file).toBe(10);
      expect(config.offerRetestIntervalMs, file).toBe(21_600_000);
      expect(config.offerCheckHourlyLimit, file).toBe(20);
    }
  });
});
