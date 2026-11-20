import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NONCE_PENDING_TTL_MS } from "../src/db.js";
import { getAgent } from "../src/db.js";
import { HandlerSandbox, handlerSnapshotRoot } from "../src/handlers.js";
import type { DirectHost } from "../src/host.js";
import { parseUsd } from "../src/money.js";
import { startServer } from "../src/server.js";
import { harness } from "./helpers.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("payment nonce reservation", () => {
  it("lets exactly one of two concurrent dry payments with the same nonce credit the seller", async () => {
    const rig = harness();
    cleanups.push(() => rig.cleanup());
    const seller = await rig.swarm.createAgent({ name: "till" });
    const buyer = await rig.swarm.createAgent({ name: "payer" });
    if (!seller.ok || !buyer.ok) throw new Error("create failed");
    rig.swarm.ownerTopup(seller.value.id, parseUsd("1.00"), "tools");
    await rig.swarm.simulateTransfer(buyer.value.id, "0x8888888888888888888888888888888888888888", parseUsd("2.00"), "fund");
    const offered = await rig.swarm.handleTool(seller.value.id, {
      id: "offer-1",
      name: "offer_service",
      arguments: { priceUsd: "0.25", description: "notes", body: "hello" },
    });
    expect(offered.ok).toBe(true);
    const price = parseUsd("0.25");
    const before = rig.swarm.snapshot(seller.value.id).balanceUnits;
    const header = `dryrun:${buyer.value.address}:${price}:same-nonce`;
    const [first, second] = await Promise.all([
      rig.swarm.settleDryPayment(seller.value.id, header),
      rig.swarm.settleDryPayment(seller.value.id, header),
    ]);
    const oks = [first, second].filter((item) => item.ok);
    expect(oks).toHaveLength(1);
    const rejected = [first, second].find((item) => !item.ok);
    expect(rejected && !rejected.ok ? rejected.error : "").toContain("nonce");
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits - before).toBe(price);
    expect(rig.swarm.snapshot(buyer.value.id).balanceUnits).toBe(parseUsd("2.00") - price);
    const credits = rig.db
      .prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE agent_id = ? AND kind = 'x402_in'")
      .get(seller.value.id) as { n: number };
    expect(credits.n).toBe(1);
  });

  it("releases a nonce when the handler fails and accepts a retry with that nonce", async () => {
    const rig = harness();
    const docker = writeFakeDocker();
    const sandbox = new HandlerSandbox({
      docker: [docker.script],
      image: "automaton:2",
      snapshotRoot: handlerSnapshotRoot(rig.dir),
      timeoutMs: 2_000,
    });
    const server = await startServer({
      config: { ...rig.config, port: 0, host: "127.0.0.1" },
      swarm: rig.swarm,
      host: {} as DirectHost,
      handlers: sandbox,
      background: false,
    });
    cleanups.push(async () => {
      await sandbox.shutdown();
      await server.close();
      docker.cleanup();
      rig.cleanup();
    });
    const seller = await rig.swarm.createAgent({ name: "till" });
    const buyer = await rig.swarm.createAgent({ name: "payer" });
    if (!seller.ok || !buyer.ok) throw new Error("create failed");
    rig.swarm.ownerTopup(seller.value.id, parseUsd("1.00"), "tools");
    await rig.swarm.simulateTransfer(buyer.value.id, "0x8888888888888888888888888888888888888888", parseUsd("1.00"), "fund");
    const agent = getAgent(rig.db, seller.value.id);
    if (!agent) throw new Error("missing");
    fs.mkdirSync(path.join(agent.workspace, "job"), { recursive: true });
    fs.writeFileSync(
      path.join(agent.workspace, "job", "handler.js"),
      [
        "let raw = '';",
        "process.stdin.on('data', (chunk) => { raw += chunk; });",
        "process.stdin.on('end', () => {",
        "  const msg = JSON.parse(raw || '{}');",
        "  if (String(msg.body || '').includes('FAIL')) process.exit(0);",
        "  process.stdout.write('paid-ok');",
        "});",
      ].join("\n"),
    );
    const registered = await rig.swarm.handleTool(seller.value.id, {
      id: "reg-echo",
      name: "serve_endpoint",
      arguments: { name: "echo", price_usd: "0.10", handler_dir: "job" },
    });
    expect(registered.ok).toBe(true);
    const price = parseUsd("0.10");
    const header = `dryrun:${buyer.value.address}:${price}:retry-nonce`;
    const sellerBefore = rig.swarm.snapshot(seller.value.id).balanceUnits;
    const failed = await fetch(`${server.url}/a/${seller.value.id}/echo`, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": header, "content-type": "text/plain" },
      body: "FAIL",
    });
    expect(failed.status).toBe(502);
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits).toBe(sellerBefore);
    const paid = await fetch(`${server.url}/a/${seller.value.id}/echo`, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": header, "content-type": "text/plain" },
      body: "go",
    });
    expect(paid.status).toBe(200);
    expect(await paid.text()).toBe("paid-ok");
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits - sellerBefore).toBe(price);
    const replay = await fetch(`${server.url}/a/${seller.value.id}/echo`, {
      headers: { "PAYMENT-SIGNATURE": header },
    });
    expect(replay.status).toBe(402);
    expect(await replay.text()).toContain("nonce");
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits - sellerBefore).toBe(price);
  });

  it("runs exactly one handler when two paid calls share a nonce", async () => {
    const rig = harness();
    const docker = writeFakeDocker();
    const sandbox = new HandlerSandbox({
      docker: [docker.script],
      image: "automaton:2",
      snapshotRoot: handlerSnapshotRoot(rig.dir),
      timeoutMs: 2_000,
    });
    const server = await startServer({
      config: { ...rig.config, port: 0, host: "127.0.0.1" },
      swarm: rig.swarm,
      host: {} as DirectHost,
      handlers: sandbox,
      background: false,
    });
    cleanups.push(async () => {
      await sandbox.shutdown();
      await server.close();
      docker.cleanup();
      rig.cleanup();
    });
    const seller = await rig.swarm.createAgent({ name: "till" });
    const buyer = await rig.swarm.createAgent({ name: "payer" });
    if (!seller.ok || !buyer.ok) throw new Error("create failed");
    rig.swarm.ownerTopup(seller.value.id, parseUsd("1.00"), "tools");
    await rig.swarm.simulateTransfer(buyer.value.id, "0x8888888888888888888888888888888888888888", parseUsd("2.00"), "fund");
    const agent = getAgent(rig.db, seller.value.id);
    if (!agent) throw new Error("missing");
    fs.mkdirSync(path.join(agent.workspace, "job"), { recursive: true });
    fs.writeFileSync(
      path.join(agent.workspace, "job", "handler.js"),
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('once'));\n",
    );
    await rig.swarm.handleTool(seller.value.id, {
      id: "reg-once",
      name: "serve_endpoint",
      arguments: { name: "once", price_usd: "0.20", handler_dir: "job" },
    });
    const price = parseUsd("0.20");
    const before = rig.swarm.snapshot(seller.value.id).balanceUnits;
    const header = `dryrun:${buyer.value.address}:${price}:once-nonce`;
    const [left, right] = await Promise.all([
      fetch(`${server.url}/a/${seller.value.id}/once`, { headers: { "PAYMENT-SIGNATURE": header } }),
      fetch(`${server.url}/a/${seller.value.id}/once`, { headers: { "PAYMENT-SIGNATURE": header } }),
    ]);
    const statuses = [left.status, right.status].sort();
    expect(statuses).toEqual([200, 402]);
    const bodies = [await left.text(), await right.text()];
    expect(bodies.filter((body) => body === "once")).toHaveLength(1);
    expect(bodies.some((body) => body.includes("nonce"))).toBe(true);
    expect(readDocker(docker.log).filter((call) => call.args[0] === "run")).toHaveLength(1);
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits - before).toBe(price);
    const credits = rig.db
      .prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE agent_id = ? AND kind = 'x402_in'")
      .get(seller.value.id) as { n: number };
    expect(credits.n).toBe(1);
  });

  it("releases a pending nonce after 60s on the injected clock", async () => {
    expect(NONCE_PENDING_TTL_MS).toBe(60_000);
    const rig = harness();
    cleanups.push(() => rig.cleanup());
    const seller = await rig.swarm.createAgent({ name: "till" });
    const buyer = await rig.swarm.createAgent({ name: "payer" });
    if (!seller.ok || !buyer.ok) throw new Error("create failed");
    rig.swarm.ownerTopup(seller.value.id, parseUsd("1.00"), "tools");
    await rig.swarm.simulateTransfer(buyer.value.id, "0x8888888888888888888888888888888888888888", parseUsd("1.00"), "fund");
    await rig.swarm.handleTool(seller.value.id, {
      id: "offer-stale",
      name: "offer_service",
      arguments: { priceUsd: "0.10", description: "notes", body: "body" },
    });
    const header = `dryrun:${buyer.value.address}:${parseUsd("0.10")}:stale-nonce`;
    const held = await rig.swarm.verifyInboundPayment(seller.value.id, header, parseUsd("0.10"));
    expect(held.ok).toBe(true);
    const blocked = await rig.swarm.verifyInboundPayment(seller.value.id, header, parseUsd("0.10"));
    expect(blocked.ok).toBe(false);
    rig.clock.advance(59_999);
    const still = await rig.swarm.verifyInboundPayment(seller.value.id, header, parseUsd("0.10"));
    expect(still.ok).toBe(false);
    rig.clock.advance(1);
    const released = await rig.swarm.verifyInboundPayment(seller.value.id, header, parseUsd("0.10"));
    expect(released.ok).toBe(true);
    if (released.ok) rig.swarm.releaseInboundPayment(released.value.nonce);
    const pending = rig.db
      .prepare("SELECT COUNT(*) AS n FROM nonces WHERE nonce = ? AND status = 'pending'")
      .get("stale-nonce") as { n: number };
    expect(pending.n).toBe(0);
  });
});

function writeFakeDocker(): { script: string; log: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-nonce-docker-"));
  const log = path.join(dir, "docker.log");
  const script = path.join(dir, "docker.cjs");
  fs.writeFileSync(log, "");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const log = ${JSON.stringify(log)};
const args = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify({ args }) + "\\n");
if (args[0] !== "run") process.exit(0);
const mountFlag = args.indexOf("--mount");
const mount = mountFlag >= 0 ? args[mountFlag + 1] : "";
const sourceMatch = /source=([^,]+)/.exec(mount);
if (!sourceMatch) process.exit(1);
const cwd = sourceMatch[1];
const child = spawn(process.execPath, ["handler.js"], { cwd, stdio: ["pipe", "pipe", "inherit"] });
child.stdin.on("error", () => undefined);
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.on("close", (code) => process.exit(code == null ? 1 : code));
`;
  fs.writeFileSync(script, source);
  fs.chmodSync(script, 0o755);
  return {
    script,
    log,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function readDocker(log: string): { args: string[] }[] {
  const text = fs.readFileSync(log, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line) as { args: string[] });
}
