import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgent } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import {
  DEFAULT_HANDLER_QUEUE_TIMEOUT_MS,
  DEFAULT_HANDLER_TIMEOUT_MS,
  HandlerSandbox,
  MAX_HANDLER_CONCURRENCY,
  PINNED_NODE_SLIM,
  buildHandlerRunArgs,
  handlerHttpStatus,
  handlerSnapshotRoot,
  selectHandlerImage,
  snapshotHandlerDir,
} from "../src/handlers.js";
import { parseUsd } from "../src/money.js";
import {
  bannerText,
  classifyAgentRoute,
  renderPageIndex,
  renderPublishedPage,
} from "../src/pages.js";
import type { DirectHost } from "../src/host.js";
import { startServer } from "../src/server.js";
import { encodePaymentHeader, signAuthorization, type PaymentSettler } from "../src/x402.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { harness } from "./helpers.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

const ATTACK = [
  "# Hello",
  "",
  "<script>document.getElementById('automaton-agent-banner').remove()</script>",
  "<style>#automaton-agent-banner{display:none !important}</style>",
  "</p><iframe src=\"https://evil.test\"></iframe>",
  "<form action=\"https://evil.test\"><input name=\"x\"></form>",
  "<img src=\"https://evil.test/a.png\">",
  "[click](javascript:alert(1))",
  "![pic](https://evil.test/a.png)",
  "**bold**",
].join("\n");

describe("hands pages", () => {
  it("renders markdown and keeps the banner outside escaped agent HTML", () => {
    const agentId = "a1234abcd";
    const html = renderPublishedPage(agentId, "note", ATTACK);
    const banner = bannerText(agentId);
    expect(html).toContain(banner);
    expect(html.indexOf('id="automaton-agent-banner"')).toBeLessThan(html.indexOf("<main>"));
    const main = html.split("<main>")[1]?.split("</main>")[0] ?? "";
    expect(main).not.toContain('id="automaton-agent-banner"');
    expect(main).toContain("<h1>Hello</h1>");
    expect(main).toContain("<strong>bold</strong>");
    expect(main).toContain("&lt;script");
    expect(main).toContain("&lt;style");
    expect(main).toContain("&lt;iframe");
    expect(main).toContain("&lt;form");
    expect(main).toContain("&lt;img");
    expect(main).toContain("pic");
    expect(html).not.toMatch(/<script[\s>]/i);
    expect(html).not.toMatch(/<iframe[\s>]/i);
    expect(html).not.toMatch(/<form[\s>]/i);
    expect(html).not.toMatch(/<img[\s>]/i);
    expect(html).not.toMatch(/href\s*=\s*["']javascript:/i);
    const index = renderPageIndex(agentId, ["note"]);
    expect(index).toContain(banner);
    expect(index).toContain("/a/a1234abcd/note");
  });

  it("refuses traversal in /a routes and does not treat them as other APIs", () => {
    expect(classifyAgentRoute("/api/overview").kind).toBe("no");
    expect(classifyAgentRoute("/admin/agents").kind).toBe("no");
    expect(classifyAgentRoute("/a/a11").kind).toBe("legacy");
    expect(classifyAgentRoute("/a/a11/").kind).toBe("index");
    expect(classifyAgentRoute("/a/a11/hello")).toEqual({ kind: "name", agentId: "a11", name: "hello" });
    for (const path of [
      "/a/a11/../a22/secret",
      "/a/a11/%2e%2e/secret",
      "/a/a11/%2fsecret",
      "/a/a11/hello/extra",
      "/a/a11/Hello",
      "/a/a11/..",
      "/a/not-an-agent/page",
    ]) {
      expect(classifyAgentRoute(path).kind).toBe("refuse");
    }
  });

  it("blocks a page that claims to be human and does not charge", async () => {
    const rig = harness();
    cleanups.push(() => rig.cleanup());
    const seller = await rig.swarm.createAgent({ name: "page" });
    if (!seller.ok) throw new Error(seller.error);
    rig.swarm.ownerTopup(seller.value.id, parseUsd("1.00"), "pages");
    const before = rig.swarm.snapshot(seller.value.id).balanceUnits;
    const refused = await rig.swarm.handleTool(seller.value.id, {
      id: "page-human",
      name: "publish_page",
      arguments: { slug: "about", markdown: "I am a human expert." },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toContain("III");
      expect(refused.reason.toLowerCase()).toContain("human");
    }
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits).toBe(before);
    expect(rig.swarm.page(seller.value.id, "about")).toBeUndefined();
    const events = rows(rig, seller.value.id);
    expect(events.some((event) => event.kind === "constitution_block")).toBe(true);
  });

  it("enforces page limits, slug rules, and the daily cap", async () => {
    const rig = harness();
    cleanups.push(() => rig.cleanup());
    const seller = await rig.swarm.createAgent({ name: "binder" });
    if (!seller.ok) throw new Error(seller.error);
    rig.swarm.ownerTopup(seller.value.id, parseUsd("1.00"), "pages");
    const before = rig.swarm.snapshot(seller.value.id).balanceUnits;
    for (const slug of ["../x", "Foo", "/etc/passwd", "a/b", ".."]) {
      const refused = await rig.swarm.handleTool(seller.value.id, {
        id: `bad-${slug}`,
        name: "publish_page",
        arguments: { slug, markdown: "hello" },
      });
      expect(refused.ok).toBe(false);
    }
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits).toBe(before);
    const huge = await rig.swarm.handleTool(seller.value.id, {
      id: "huge",
      name: "publish_page",
      arguments: { slug: "huge", markdown: "a".repeat(200 * 1024 + 1) },
    });
    expect(huge.ok).toBe(false);
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits).toBe(before);
    for (let i = 0; i < 20; i += 1) {
      const published = await rig.swarm.handleTool(seller.value.id, {
        id: `page-${i}`,
        name: "publish_page",
        arguments: { slug: `p${i}`, markdown: `Page ${i}` },
      });
      expect(published.ok).toBe(true);
    }
    const extra = await rig.swarm.handleTool(seller.value.id, {
      id: "page-extra",
      name: "publish_page",
      arguments: { slug: "overflow", markdown: "nope" },
    });
    expect(extra.ok).toBe(false);
    expect(rig.swarm.listPages(seller.value.id)).toHaveLength(20);
    const updated = await rig.swarm.handleTool(seller.value.id, {
      id: "page-update",
      name: "publish_page",
      arguments: { slug: "p0", markdown: "replaced" },
    });
    expect(updated.ok).toBe(true);
    expect(rig.swarm.page(seller.value.id, "p0")?.markdown).toBe("replaced");
    expect(rig.swarm.listPages(seller.value.id)).toHaveLength(20);
    const spent = before - rig.swarm.snapshot(seller.value.id).balanceUnits;
    expect(spent).toBe(21 * parseUsd("0.001"));
  });

  it("refuses a publish that would cross the daily spend cap", async () => {
    const rig = harness({ AGENT_DAILY_CAP_USD: "0.0001" });
    cleanups.push(() => rig.cleanup());
    const seller = await rig.swarm.createAgent({ name: "capped" });
    if (!seller.ok) throw new Error(seller.error);
    rig.swarm.ownerTopup(seller.value.id, parseUsd("1.00"), "cap");
    const before = rig.swarm.snapshot(seller.value.id).balanceUnits;
    const refused = await rig.swarm.handleTool(seller.value.id, {
      id: "capped-page",
      name: "publish_page",
      arguments: { slug: "note", markdown: "A normal note." },
    });
    expect(refused.ok).toBe(false);
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits).toBe(before);
    expect(rig.swarm.page(seller.value.id, "note")).toBeUndefined();
  });
});

describe("hands endpoints", () => {
  it("uses a 10s default timeout and the node image when the agent image has Node", () => {
    expect(DEFAULT_HANDLER_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_HANDLER_QUEUE_TIMEOUT_MS).toBe(10_000);
    expect(MAX_HANDLER_CONCURRENCY).toBe(2);
    const sandbox = new HandlerSandbox({ docker: ["docker"], image: "automaton:2", snapshotRoot: os.tmpdir() });
    expect(sandbox.timeoutMs).toBe(10_000);
    expect(sandbox.concurrency).toBe(2);
    expect(selectHandlerImage("automaton:2", true)).toBe("automaton:2");
    expect(selectHandlerImage("custom:no-node", false)).toBe(PINNED_NODE_SLIM);
    expect(PINNED_NODE_SLIM).toBe("node:22.21.0-bookworm-slim");
    const config = loadConfig({ WALLET_MASTER_KEY: "test-master-key-1234", DATA_DIR: os.tmpdir() });
    expect(config.publishPagePriceUnits).toBe(parseUsd("0.001"));
    expect(config.serveEndpointPriceUnits).toBe(parseUsd("0.002"));
    expect(config.serveMinPriceUnits).toBe(parseUsd("0.001"));
    expect(config.serveMaxPriceUnits).toBe(parseUsd("1"));
    expect(config.handlerTimeoutMs).toBe(10_000);
    expect(config.handlerImage).toBe("automaton:2");
    expect(loadConfig({ WALLET_MASTER_KEY: "test-master-key-1234", AGENT_IMAGE_HAS_NODE: "false" }).handlerImage).toBe(PINNED_NODE_SLIM);
    const args = buildHandlerRunArgs({ name: "h", image: "automaton:2", mount: "type=bind,source=/snap,target=/handler,readonly", user: "65534:65534" });
    expect(args).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "--memory", "128m", "--cap-drop", "ALL"]));
    expect(args).not.toContain("-e");
    expect(handlerHttpStatus("busy")).toBe(503);
    expect(handlerHttpStatus("timeout")).toBe(502);
  });

  it("enforces price bounds and refuses handler path traversal", async () => {
    const rig = harness();
    cleanups.push(() => rig.cleanup());
    const seller = await rig.swarm.createAgent({ name: "bounds" });
    if (!seller.ok) throw new Error(seller.error);
    rig.swarm.ownerTopup(seller.value.id, parseUsd("1.00"), "fee");
    const before = rig.swarm.snapshot(seller.value.id).balanceUnits;
    const agent = getAgent(rig.db, seller.value.id);
    if (!agent) throw new Error("missing agent");
    fs.mkdirSync(path.join(agent.workspace, "job"), { recursive: true });
    fs.writeFileSync(path.join(agent.workspace, "job", "handler.js"), "process.stdout.write('ok');\n");
    for (const price of ["0.000999", "1.01", "0"]) {
      const refused = await rig.swarm.handleTool(seller.value.id, {
        id: `price-${price}`,
        name: "serve_endpoint",
        arguments: { name: "job", price_usd: price, handler_dir: "job" },
      });
      expect(refused.ok).toBe(false);
    }
    for (const handlerDir of ["../job", "/etc", "job/nested", "..", "Job"]) {
      const refused = await rig.swarm.handleTool(seller.value.id, {
        id: `dir-${handlerDir}`,
        name: "serve_endpoint",
        arguments: { name: "job", price_usd: "0.01", handler_dir: handlerDir },
      });
      expect(refused.ok).toBe(false);
    }
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-outside-"));
    cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, "handler.js"), "process.stdout.write('secret-outside');\n");
    fs.symlinkSync(outside, path.join(agent.workspace, "linked"));
    const linked = await rig.swarm.handleTool(seller.value.id, {
      id: "linked",
      name: "serve_endpoint",
      arguments: { name: "job", price_usd: "0.01", handler_dir: "linked" },
    });
    expect(linked.ok).toBe(false);
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits).toBe(before);
    expect(rig.swarm.endpoint(seller.value.id, "job")).toBeUndefined();
    const snapped = snapshotHandlerDir({ workspace: agent.workspace, handlerDir: "..", storeRoot: handlerSnapshotRoot(rig.dir) });
    expect(snapped.ok).toBe(false);

    const min = await rig.swarm.handleTool(seller.value.id, {
      id: "price-min",
      name: "serve_endpoint",
      arguments: { name: "cheap", price_usd: "0.001", handler_dir: "job" },
    });
    const max = await rig.swarm.handleTool(seller.value.id, {
      id: "price-max",
      name: "serve_endpoint",
      arguments: { name: "dear", price_usd: "1.00", handler_dir: "job" },
    });
    expect(min.ok).toBe(true);
    expect(max.ok).toBe(true);
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits).toBe(before - 2 * parseUsd("0.002"));
    for (let i = 0; i < 3; i += 1) {
      const extra = await rig.swarm.handleTool(seller.value.id, {
        id: `more-${i}`,
        name: "serve_endpoint",
        arguments: { name: `e${i}`, price_usd: "0.01", handler_dir: "job" },
      });
      expect(extra.ok).toBe(true);
    }
    const sixth = await rig.swarm.handleTool(seller.value.id, {
      id: "sixth",
      name: "serve_endpoint",
      arguments: { name: "sixth", price_usd: "0.01", handler_dir: "job" },
    });
    expect(sixth.ok).toBe(false);
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits).toBe(before - 5 * parseUsd("0.002"));
  });

  it("serves a banner page and a paid handler that credits the ledger once", async () => {
    const rig = harness();
    const docker = writeFakeDocker();
    const secrets = { WALLET_MASTER_KEY: "super-secret-master", ADMIN_TOKEN: "super-secret-admin", OPENROUTER_API_KEY: "sk-or-secret" };
    const previous = stashEnv(secrets);
    const sandbox = new HandlerSandbox({
      docker: [docker.script],
      image: rig.config.handlerImage,
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
      restoreEnv(previous);
      fs.writeFileSync(docker.release, "go");
      await sandbox.shutdown();
      await server.close();
      docker.cleanup();
      rig.cleanup();
    });

    const seller = await rig.swarm.createAgent({ name: "maker" });
    const buyer = await rig.swarm.createAgent({ name: "buyer" });
    if (!seller.ok || !buyer.ok) throw new Error("create failed");
    rig.swarm.ownerTopup(seller.value.id, parseUsd("1.00"), "tools");
    await rig.swarm.simulateTransfer(buyer.value.id, "0x8888888888888888888888888888888888888888", parseUsd("1.00"), "fund-buyer");
    const agent = getAgent(rig.db, seller.value.id);
    if (!agent) throw new Error("missing");
    fs.writeFileSync(path.join(agent.workspace, "secret.txt"), "TOP-SECRET-CANARY");
    fs.mkdirSync(path.join(agent.workspace, "job"), { recursive: true });
    fs.writeFileSync(path.join(agent.workspace, "job", "handler.js"), "process.stdout.write('version-1');\nprocess.exit(0);\n");

    const published = await rig.swarm.handleTool(seller.value.id, {
      id: "pub-1",
      name: "publish_page",
      arguments: { slug: "note", markdown: ATTACK },
    });
    expect(published.ok).toBe(true);
    const page = await fetch(`${server.url}/a/${seller.value.id}/note`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain(bannerText(seller.value.id));
    expect(html).not.toMatch(/<script[\s>]/i);
    expect(html).toContain("&lt;script");
    expect(html).not.toContain("TOP-SECRET-CANARY");
    const index = await fetch(`${server.url}/a/${seller.value.id}/`);
    const indexHtml = await index.text();
    expect(index.status).toBe(200);
    expect(indexHtml).toContain(bannerText(seller.value.id));
    expect(indexHtml).toContain(`/a/${seller.value.id}/note`);
    const other = await rig.swarm.createAgent({ name: "other" });
    if (!other.ok) throw new Error(other.error);
    rig.swarm.ownerTopup(other.value.id, parseUsd("1.00"), "other");
    await rig.swarm.handleTool(other.value.id, {
      id: "other-page",
      name: "publish_page",
      arguments: { slug: "hidden", markdown: "OTHER-AGENT-PAGE" },
    });
    const indexAgain = await (await fetch(`${server.url}/a/${seller.value.id}/`)).text();
    expect(indexAgain).not.toContain("hidden");
    expect(indexAgain).not.toContain("OTHER-AGENT-PAGE");

    const traversal = await rawGet(server.url, `/a/${seller.value.id}/%2e%2e/%2e%2e/etc/passwd`);
    expect(traversal.status).toBe(400);
    expect(traversal.body).not.toContain("TOP-SECRET-CANARY");
    expect(traversal.body).not.toContain("root:");
    const slipped = await rawGet(server.url, `/a/${seller.value.id}/../../api/overview`);
    expect(slipped.status).toBe(400);
    expect(slipped.body).not.toContain("killSwitch");

    const price = parseUsd("0.05");
    const registered = await rig.swarm.handleTool(seller.value.id, {
      id: "reg-1",
      name: "serve_endpoint",
      arguments: { name: "echo", price_usd: "0.05", handler_dir: "job" },
    });
    expect(registered.ok).toBe(true);
    const endpoint = rig.swarm.endpoint(seller.value.id, "echo");
    expect(endpoint?.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    const unpaid = await fetch(`${server.url}/a/${seller.value.id}/echo`);
    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get("x-automaton-disclosure")).toContain("AI");
    const challenge = JSON.parse(await unpaid.text()) as { x402Version: number; accepts: { amount: string }[] };
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts[0]?.amount).toBe(String(price));

    const header = `dryrun:${buyer.value.address}:${price}:nonce-pay-1`;
    const paid = await fetch(`${server.url}/a/${seller.value.id}/echo`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(await paid.text()).toBe("version-1");
    expect(paid.status).toBe(200);
    const afterSale = rig.swarm.snapshot(seller.value.id).balanceUnits;
    const offerFee = parseUsd("0.001");
    const registerFee = parseUsd("0.002");
    expect(afterSale).toBe(parseUsd("1.00") - offerFee - registerFee + price);
    expect(rig.swarm.snapshot(buyer.value.id).balanceUnits).toBe(parseUsd("1.00") - price);

    fs.writeFileSync(path.join(agent.workspace, "job", "handler.js"), "process.stdout.write('version-2');\nprocess.exit(0);\n");
    const again = await fetch(`${server.url}/a/${seller.value.id}/echo`, {
      headers: { "PAYMENT-SIGNATURE": `dryrun:${buyer.value.address}:${price}:nonce-pay-2` },
    });
    expect(again.status).toBe(200);
    expect(await again.text()).toBe("version-1");

    const replay = await fetch(`${server.url}/a/${seller.value.id}/echo`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(replay.status).toBe(402);
    expect(await replay.text()).toContain("nonce");
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits).toBe(afterSale + price);
    expect(rig.swarm.snapshot(buyer.value.id).balanceUnits).toBe(parseUsd("1.00") - 2 * price);

    const calls = readDocker(docker.log);
    const run = calls.find((call) => call.args[0] === "run");
    expect(run).toBeTruthy();
    expect(run?.args).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "--memory", "128m", "--cap-drop", "ALL"]));
    expect(run?.args).not.toContain("-e");
    expect(run?.args).not.toContain("--env");
    const joined = run?.args.join(" ") ?? "";
    expect(joined).not.toContain("WALLET_MASTER_KEY");
    expect(joined).not.toContain("ADMIN_TOKEN");
    expect(joined).not.toContain("OPENROUTER_API_KEY");
    expect(joined).not.toContain("super-secret-master");
    expect(joined).not.toContain("sk-or-secret");
    expect(run?.env.WALLET_MASTER_KEY).toBe("");
    expect(run?.env.ADMIN_TOKEN).toBe("");
    expect(run?.env.OPENROUTER_API_KEY).toBe("");
    const mount = run?.args[run.args.indexOf("--mount") + 1] ?? "";
    expect(mount).toContain("handler-snapshots");
    expect(mount).toContain("readonly");
    expect(mount).not.toContain(`${path.sep}workspace`);
    expect(run?.args).toContain("node");
    expect(run?.args).toContain("handler.js");
    expect(run?.args).toContain("65534:65534");

    const logged = rows(rig, seller.value.id);
    expect(logged.some((event) => event.kind === "publish_page" && event.message.includes("outcome=ok") && event.message.includes("slug=note"))).toBe(true);
    expect(logged.some((event) => event.kind === "serve_endpoint" && event.message.includes("outcome=ok"))).toBe(true);
    expect(logged.filter((event) => event.kind === "paid_call" && event.message.includes("outcome=ok") && event.message.includes(`price=${price}`))).toHaveLength(2);
  });

  it("does not settle a live payment until the handler succeeds, and rejects a replay", async () => {
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
    if (!seller.ok) throw new Error(seller.error);
    rig.swarm.ownerTopup(seller.value.id, parseUsd("1.00"), "tools");
    const agent = getAgent(rig.db, seller.value.id);
    if (!agent) throw new Error("missing");
    fs.mkdirSync(path.join(agent.workspace, "job"), { recursive: true });
    fs.writeFileSync(path.join(agent.workspace, "job", "handler.js"), "process.stdout.write('pong');\nprocess.exit(0);\n");
    fs.mkdirSync(path.join(agent.workspace, "blank"), { recursive: true });
    fs.writeFileSync(
      path.join(agent.workspace, "blank", "handler.js"),
      "process.stdin.on('data', () => undefined);\nprocess.stdin.on('end', () => process.exit(0));\n",
    );
    await rig.swarm.handleTool(seller.value.id, {
      id: "reg-echo",
      name: "serve_endpoint",
      arguments: { name: "echo", price_usd: "0.10", handler_dir: "job" },
    });
    await rig.swarm.handleTool(seller.value.id, {
      id: "reg-blank",
      name: "serve_endpoint",
      arguments: { name: "blank", price_usd: "0.10", handler_dir: "blank" },
    });
    const settler = new ScriptedSettler([{ ok: true, txHash: `0x${"ab".repeat(32)}` }]);
    rig.swarm.setSettler(settler);
    const payerKey = generatePrivateKey();
    const blankHeader = await signed(rig, payerKey, seller.value.address, parseUsd("0.10"), "11");
    const before = rig.swarm.snapshot(seller.value.id).balanceUnits;
    const empty = await fetch(`${server.url}/a/${seller.value.id}/blank`, { headers: { "PAYMENT-SIGNATURE": blankHeader } });
    expect(empty.status).toBe(502);
    expect(await empty.text()).toContain("no output");
    expect(settler.calls).toBe(0);
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits).toBe(before);
    expect(rows(rig, seller.value.id).some((event) => event.kind === "handler_failed" && event.message.includes("outcome=empty"))).toBe(true);

    const header = await signed(rig, payerKey, seller.value.address, parseUsd("0.10"), "22");
    const paid = await fetch(`${server.url}/a/${seller.value.id}/echo`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(paid.status).toBe(200);
    expect(await paid.text()).toBe("pong");
    expect(settler.calls).toBe(1);
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits - before).toBe(parseUsd("0.10"));
    const replay = await fetch(`${server.url}/a/${seller.value.id}/echo`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(replay.status).toBe(402);
    expect(settler.calls).toBe(1);
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits - before).toBe(parseUsd("0.10"));
  });

  it("kills a looping handler on the docker kill path and does not charge the buyer", async () => {
    const rig = harness();
    const docker = writeFakeDocker();
    const sandbox = new HandlerSandbox({
      docker: [docker.script],
      image: "automaton:2",
      snapshotRoot: handlerSnapshotRoot(rig.dir),
      timeoutMs: 80,
    });
    expect(sandbox.timeoutMs).toBe(80);
    expect(DEFAULT_HANDLER_TIMEOUT_MS).toBe(10_000);
    const server = await startServer({
      config: { ...rig.config, port: 0, host: "127.0.0.1" },
      swarm: rig.swarm,
      host: {} as DirectHost,
      handlers: sandbox,
      background: false,
    });
    cleanups.push(async () => {
      fs.writeFileSync(docker.release, "go");
      await sandbox.shutdown();
      await server.close();
      docker.cleanup();
      rig.cleanup();
    });
    const seller = await rig.swarm.createAgent({ name: "loop" });
    const buyer = await rig.swarm.createAgent({ name: "payer" });
    if (!seller.ok || !buyer.ok) throw new Error("create failed");
    rig.swarm.ownerTopup(seller.value.id, parseUsd("1.00"), "tools");
    await rig.swarm.simulateTransfer(buyer.value.id, "0x8888888888888888888888888888888888888888", parseUsd("1.00"), "fund");
    const agent = getAgent(rig.db, seller.value.id);
    if (!agent) throw new Error("missing");
    fs.mkdirSync(path.join(agent.workspace, "job"), { recursive: true });
    fs.writeFileSync(path.join(agent.workspace, "job", "handler.js"), "/* STAY_OPEN */\nsetInterval(() => {}, 1000);\n");
    await rig.swarm.handleTool(seller.value.id, {
      id: "reg-loop",
      name: "serve_endpoint",
      arguments: { name: "loop", price_usd: "0.20", handler_dir: "job" },
    });
    const sellerBefore = rig.swarm.snapshot(seller.value.id).balanceUnits;
    const buyerBefore = rig.swarm.snapshot(buyer.value.id).balanceUnits;
    const chainBefore = await rig.chain.getBalance(buyer.value.address);
    const price = parseUsd("0.20");
    const response = await fetch(`${server.url}/a/${seller.value.id}/loop`, {
      headers: { "PAYMENT-SIGNATURE": `dryrun:${buyer.value.address}:${price}:nonce-loop-1` },
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("timed out");
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits).toBe(sellerBefore);
    expect(rig.swarm.snapshot(buyer.value.id).balanceUnits).toBe(buyerBefore);
    expect((await rig.chain.getBalance(buyer.value.address)).units).toBe(chainBefore.units);
    const calls = readDocker(docker.log);
    expect(calls.some((call) => call.args[0] === "kill")).toBe(true);
    expect(calls.some((call) => call.args[0] === "rm" && call.args.includes("-f"))).toBe(true);
    expect(rows(rig, seller.value.id).some((event) => event.kind === "handler_failed" && event.message.includes("outcome=timeout"))).toBe(true);
  }, 4_000);

  it("runs at most two handler containers and returns 503 for the rest", async () => {
    const rig = harness();
    const docker = writeFakeDocker();
    const sandbox = new HandlerSandbox({
      docker: [docker.script],
      image: "automaton:2",
      snapshotRoot: handlerSnapshotRoot(rig.dir),
      timeoutMs: 4_000,
      queueTimeoutMs: 150,
    });
    expect(sandbox.concurrency).toBe(2);
    const server = await startServer({
      config: { ...rig.config, port: 0, host: "127.0.0.1" },
      swarm: rig.swarm,
      host: {} as DirectHost,
      handlers: sandbox,
      background: false,
    });
    cleanups.push(async () => {
      fs.writeFileSync(docker.release, "go");
      await sandbox.shutdown();
      await server.close();
      docker.cleanup();
      rig.cleanup();
    });
    const seller = await rig.swarm.createAgent({ name: "gate" });
    const buyer = await rig.swarm.createAgent({ name: "crowd" });
    if (!seller.ok || !buyer.ok) throw new Error("create failed");
    rig.swarm.ownerTopup(seller.value.id, parseUsd("1.00"), "tools");
    await rig.swarm.simulateTransfer(buyer.value.id, "0x8888888888888888888888888888888888888888", parseUsd("1.00"), "fund");
    const agent = getAgent(rig.db, seller.value.id);
    if (!agent) throw new Error("missing");
    fs.mkdirSync(path.join(agent.workspace, "job"), { recursive: true });
    fs.writeFileSync(path.join(agent.workspace, "job", "handler.js"), "/* STAY_OPEN */\nsetInterval(() => {}, 1000);\n");
    await rig.swarm.handleTool(seller.value.id, {
      id: "reg-hold",
      name: "serve_endpoint",
      arguments: { name: "hold", price_usd: "0.01", handler_dir: "job" },
    });
    const price = parseUsd("0.01");
    const pay = (nonce: string) =>
      fetch(`${server.url}/a/${seller.value.id}/hold`, {
        headers: { "PAYMENT-SIGNATURE": `dryrun:${buyer.value.address}:${price}:${nonce}` },
      });
    const first = pay("nonce-hold-1");
    const second = pay("nonce-hold-2");
    await waitFor(() => readDocker(docker.log).filter((call) => call.args[0] === "run").length >= 2);
    const third = await pay("nonce-hold-3");
    expect(third.status).toBe(503);
    expect(readDocker(docker.log).filter((call) => call.args[0] === "run")).toHaveLength(2);
    const sellerBefore = rig.swarm.snapshot(seller.value.id).balanceUnits;
    fs.writeFileSync(docker.release, "go");
    const finished = await Promise.all([first, second]);
    expect(finished.map((item) => item.status)).toEqual([502, 502]);
    expect(readDocker(docker.log).filter((call) => call.args[0] === "run")).toHaveLength(2);
    expect(rig.swarm.snapshot(seller.value.id).balanceUnits).toBe(sellerBefore);
    expect(rig.swarm.snapshot(buyer.value.id).balanceUnits).toBe(parseUsd("1.00"));
  }, 8_000);
});

class ScriptedSettler implements PaymentSettler {
  calls = 0;
  constructor(private readonly results: Array<{ ok: true; txHash: string } | { ok: false; error: string }>) {}
  async settle(): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
    const next = this.results[this.calls++] ?? { ok: false as const, error: "no scripted result" };
    return next;
  }
}

function rows(rig: ReturnType<typeof harness>, agentId: string): { kind: string; message: string }[] {
  return rig.db.prepare("SELECT kind, message FROM events WHERE agent_id = ? ORDER BY id ASC").all(agentId) as unknown as {
    kind: string;
    message: string;
  }[];
}

async function signed(
  rig: ReturnType<typeof harness>,
  privateKey: `0x${string}`,
  to: string,
  units: number,
  nonceByte: string,
): Promise<string> {
  const payer = privateKeyToAccount(privateKey);
  const message = {
    from: payer.address,
    to: to as `0x${string}`,
    value: BigInt(units),
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: `0x${nonceByte.repeat(32)}` as const,
  };
  const signature = await signAuthorization(privateKey, rig.config, message);
  return encodePaymentHeader({
    config: rig.config,
    message,
    signature,
    resource: `/a/${to}`,
    description: "endpoint",
  });
}

function stashEnv(values: Record<string, string>): Record<string, string | undefined> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return previous;
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function writeFakeDocker(): { script: string; log: string; release: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-fake-docker-"));
  const log = path.join(dir, "docker.log");
  const release = path.join(dir, "release");
  const script = path.join(dir, "docker.cjs");
  fs.writeFileSync(log, "");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const log = ${JSON.stringify(log)};
const release = ${JSON.stringify(release)};
const args = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify({
  args,
  env: {
    WALLET_MASTER_KEY: process.env.WALLET_MASTER_KEY || "",
    ADMIN_TOKEN: process.env.ADMIN_TOKEN || "",
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
  },
}) + "\\n");
const cmd = args[0];
if (cmd === "kill" || cmd === "rm" || cmd !== "run") process.exit(0);
const mountFlag = args.indexOf("--mount");
const mount = mountFlag >= 0 ? args[mountFlag + 1] : "";
const sourceMatch = /source=([^,]+)/.exec(mount);
if (!sourceMatch) process.exit(1);
const cwd = sourceMatch[1];
const src = fs.readFileSync(path.join(cwd, "handler.js"), "utf8");
if (src.includes("STAY_OPEN")) {
  const timer = setInterval(() => {
    if (fs.existsSync(release)) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 15);
  return;
}
process.stdin.on("error", () => undefined);
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
    release,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function readDocker(log: string): { args: string[]; env: Record<string, string> }[] {
  const text = fs.readFileSync(log, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
}

function rawGet(base: string, requestPath: string): Promise<{ status: number; body: string }> {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: requestPath, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 3_000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("timed out waiting");
}
