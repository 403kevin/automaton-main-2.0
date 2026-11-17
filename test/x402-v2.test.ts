import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BASE_SEPOLIA_USDC, PUBLIC_SEPOLIA_FACILITATOR } from "../src/x402.js";
import {
  X402_HEADERS,
  caipNetwork,
  facilitatorSettleBody,
  networkMatches,
  paymentRequirements,
  v2PaymentHeaders,
} from "../src/x402.js";
import { fetchWithBackoff, rateLimitCounts, resetRateLimits } from "../src/http.js";
import { harness } from "./helpers.js";

describe("x402 v2", () => {
  it("uses the CAIP-2 network and v2 header names, and the Sepolia USDC address", () => {
    const config = loadConfig({
      WALLET_MASTER_KEY: "test-master-key-1234",
      NETWORK: "base-sepolia",
      MONEY_MODE: "dry-run",
    });
    expect(config.usdcAddress).toBe(BASE_SEPOLIA_USDC);
    expect(config.usdcAddress).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(caipNetwork(config)).toBe("eip155:84532");
    expect(networkMatches(config, "eip155:84532")).toBe(true);
    expect(networkMatches(config, "base-sepolia")).toBe(false);
    const requirements = paymentRequirements({
      config,
      payTo: config.treasury,
      amountUnits: 10_000n,
      resource: "/a/test",
      description: "An AI response.",
    });
    const accept = (requirements.accepts as { network: string; maxAmountRequired?: string }[])[0];
    expect(requirements.x402Version).toBe(2);
    expect(accept?.network).toBe("eip155:84532");
    expect(accept?.maxAmountRequired).toBeUndefined();
    expect(X402_HEADERS).toEqual({
      required: "PAYMENT-REQUIRED",
      signature: "PAYMENT-SIGNATURE",
      response: "PAYMENT-RESPONSE",
    });
    const signature = "eyJ4NDAyVmVyc2lvbiI6Mn0=";
    expect(v2PaymentHeaders(signature)).toEqual({ "PAYMENT-SIGNATURE": signature });
    expect(v2PaymentHeaders(signature)["X-PAYMENT" as "PAYMENT-SIGNATURE"]).toBeUndefined();
    const body = facilitatorSettleBody({
      config,
      message: {
        from: config.treasury,
        to: config.treasury,
        value: 10_000n,
        validAfter: 0n,
        validBefore: 4_000_000_000n,
        nonce: `0x${"ab".repeat(32)}`,
      },
      signature: "0x11",
      resource: "/a/test",
      description: "An AI response.",
    });
    const requirementsOut = body.paymentRequirements as { network: string };
    expect(body.x402Version).toBe(2);
    expect(requirementsOut.network).toBe("eip155:84532");
    const live = loadConfig({
      ...configEnv(),
      MONEY_MODE: "live",
      TREASURY_ADDRESS: "0x2222222222222222222222222222222222222222",
    });
    expect(live.facilitatorUrl).toBe(PUBLIC_SEPOLIA_FACILITATOR);
  });

  it("counts HTTP 429 responses and backs off", async () => {
    resetRateLimits();
    let calls = 0;
    const response = await fetchWithBackoff("https://x402.org/facilitator/settle", undefined, "facilitator", {
      sleep: async () => undefined,
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("slow", { status: 429, headers: { "retry-after": "1" } })
          : new Response("ok", { status: 200 });
      },
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(rateLimitCounts().facilitator).toBe(1);
    const rig = harness();
    const report = rig.swarm.writeDailyReport();
    expect(report.markdown).toContain("HTTP 429: facilitator 1, openrouter 0, search 0");
    rig.cleanup();
    resetRateLimits();
  });
});

function configEnv(): Record<string, string> {
  return {
    WALLET_MASTER_KEY: "test-master-key-1234",
    NETWORK: "base-sepolia",
    ADMIN_TOKEN: "test-admin",
  };
}
