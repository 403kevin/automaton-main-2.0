import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { HttpUrlChecker, SandboxOfferVerifier } from "../src/verify-offer.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("buildApp wiring", () => {
  it("installs the real offer verifier and URL checker, in mock mode with no Docker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-app-"));
    const app = await buildApp({
      DATA_DIR: dir,
      MONEY_MODE: "dry-run",
      NETWORK: "base-sepolia",
      LLM_MODE: "mock",
      RUNTIME: "process",
      WALLET_MASTER_KEY: "test-master-key-1234",
      ADMIN_TOKEN: "test-admin",
      TREASURY_ADDRESS: "0x1111111111111111111111111111111111111111",
    });
    cleanups.push(async () => {
      await app.handlers.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const ports = app.swarm.offerPorts();
    expect(ports.verifier).toBeInstanceOf(SandboxOfferVerifier);
    expect(ports.urlChecker).toBeInstanceOf(HttpUrlChecker);
  });
});
