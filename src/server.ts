import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PUBLIC_MAINNET_REFUSAL, type AppConfig } from "./config.js";
import { dashboardHtml } from "./dashboard.js";
import { HandlerSandbox, handlerHttpStatus, handlerSnapshotRoot } from "./handlers.js";
import type { DirectHost } from "./host.js";
import { formatUsd, parseUsd } from "./money.js";
import { classifyAgentRoute, renderPageIndex, renderPublishedPage, type AgentRoute } from "./pages.js";
import { type BrowseLlmProxy, startInternalLlmServer } from "./llm-proxy.js";
import { caipNetwork, encodeHeaderValue, paymentRequirements, X402_HEADERS } from "./x402.js";
import type { Swarm } from "./swarm.js";
import { redact } from "./redact.js";
import type { ChatMessage, ServedEndpoint, ToolCall } from "./types.js";

export interface ServerHandle {
  url: string;
  /** The `/a/*`-only listener's address, set only when PUBLIC_PORT is above 0 (specs/BO-4.3). */
  publicUrl?: string;
  close(): Promise<void>;
}

/** Decides whether a verified buyer wallet may pay on a listener. Absent means every buyer may. */
type BuyerGate = (from: string) => boolean;

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function boundPort(server: Server, fallback: number): number {
  const address = server.address();
  return typeof address === "object" && address ? address.port : fallback;
}

function closeListener(server: Server): Promise<void> {
  return new Promise((done, fail) => {
    if (!server.listening) {
      done();
      return;
    }
    server.closeAllConnections();
    server.close((error) => (error ? fail(error) : done()));
  });
}

export function startServer(input: {
  config: AppConfig;
  swarm: Swarm;
  host: DirectHost;
  handlers?: HandlerSandbox;
  background?: boolean;
  llmProxy?: BrowseLlmProxy;
}): Promise<ServerHandle> {
  const { config, swarm, host } = input;
  // The public listener is for Base Sepolia test-buys only; a hand-built config gets the same refusal as loadConfig.
  if (config.publicPort > 0 && config.allowMainnet) return Promise.reject(new Error(PUBLIC_MAINNET_REFUSAL));
  const handlers = input.handlers ?? defaultHandlers(config);
  const fail500 = (res: ServerResponse, error: unknown) => {
    const message = redact(error instanceof Error ? error.message : "Request failed.");
    send(res, 500, { error: message });
  };
  const server = createServer((req, res) => {
    void handle(req, res, config, swarm, host, handlers).catch((error) => fail500(res, error));
  });
  const gate: BuyerGate | undefined =
    config.publicBuyerAllowlist.size > 0 ? (from) => config.publicBuyerAllowlist.has(from.toLowerCase()) : undefined;
  const publicServer =
    config.publicPort > 0
      ? createServer((req, res) => {
          void handlePublic(req, res, config, swarm, handlers, gate).catch((error) => fail500(res, error));
        })
      : null;
  const internalReady = input.llmProxy
    ? startInternalLlmServer(input.llmProxy, config.internalLlmPort, config.internalLlmHost)
    : Promise.resolve(null);
  return internalReady.then(
    async (internal) => {
      try {
        await listen(server, config.port, config.host);
        if (publicServer) await listen(publicServer, config.publicPort, config.publicHost);
      } catch (error) {
        await Promise.allSettled([closeListener(server), publicServer ? closeListener(publicServer) : Promise.resolve(), internal?.close()]);
        throw error;
      }
      if (input.background !== false) {
        swarm.startScheduler();
        swarm.startReports();
        void swarm.resumeLiving();
      }
      const origin = (bindHost: string, port: number) => `http://${bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost}:${port}`;
      const started: ServerHandle = {
        url: origin(config.host, boundPort(server, config.port)),
        close: () =>
          new Promise((done, failClose) => {
            void handlers.shutdown().finally(() => {
              void swarm.haltBodies().finally(() => {
                const finish = () => {
                  const closing = [closeListener(server), publicServer ? closeListener(publicServer) : Promise.resolve()];
                  void Promise.all(closing).then(() => done(), failClose);
                };
                if (!internal) {
                  finish();
                  return;
                }
                void internal.close().finally(finish);
              });
            });
          }),
      };
      if (publicServer) started.publicUrl = origin(config.publicHost, boundPort(publicServer, config.publicPort));
      return started;
    },
    (error) => {
      server.close();
      return Promise.reject(error);
    },
  );
}

function defaultHandlers(config: AppConfig): HandlerSandbox {
  return new HandlerSandbox({
    docker: ["docker"],
    image: config.handlerImage,
    snapshotRoot: handlerSnapshotRoot(config.dataDir),
    dockerVolume: config.dockerVolume,
    timeoutMs: config.handlerTimeoutMs,
    queueTimeoutMs: config.handlerQueueTimeoutMs,
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  swarm: Swarm,
  host: DirectHost,
  handlers: HandlerSandbox,
): Promise<void> {
  const rawPath = (req.url ?? "/").split("?")[0] || "/";
  const path = rawPath;
  if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
  if (req.method === "GET" && path === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" });
    res.end(dashboardHtml());
    return;
  }
  if (req.method === "GET" && path === "/api/overview") return send(res, 200, swarm.overview());

  const agentRoute = classifyAgentRoute(path);
  if (agentRoute.kind !== "no") return serveAgentRoute(req, res, agentRoute, config, swarm, handlers, undefined);

  if (path.startsWith("/admin/")) {
    if (!adminOk(req, config.adminToken)) return send(res, 401, { error: "Admin token rejected." });
    const body = await readJson(req);
    if (req.method === "POST" && path === "/admin/agents") {
      const created = await swarm.createAgent({
        name: String(body.name ?? ""),
        genesisPrompt: body.genesisPrompt ? String(body.genesisPrompt) : undefined,
        model: body.model ? String(body.model) : undefined,
        lowModel: body.lowModel ? String(body.lowModel) : undefined,
        criticalModel: body.criticalModel ? String(body.criticalModel) : undefined,
      });
      if (!created.ok) return send(res, 400, { error: created.error });
      return send(res, 201, { id: created.value.id, name: created.value.name, address: created.value.address, depth: created.value.depth });
    }
    const modelRoute = /^\/admin\/agents\/(a[a-f0-9]+)\/model$/.exec(path);
    if (req.method === "POST" && modelRoute) {
      const changed = swarm.setAgentModels(modelRoute[1] ?? "", {
        model: "model" in body ? body.model : undefined,
        lowModel: "lowModel" in body ? body.lowModel : undefined,
        criticalModel: "criticalModel" in body ? body.criticalModel : undefined,
      });
      if (!changed.ok) return send(res, 400, { error: changed.error });
      return send(res, 200, changed.value);
    }
    if (req.method === "POST" && path === "/admin/topup") {
      const topped = swarm.ownerTopup(String(body.agentId ?? ""), parseUsd(String(body.usd ?? "")), body.ref ? String(body.ref) : undefined);
      if (!topped.ok) return send(res, 400, { error: topped.error });
      return send(res, 200, topped.value);
    }
    if (req.method === "POST" && path === "/admin/kill-switch") {
      await swarm.setKillSwitch(Boolean(body.enabled));
      return send(res, 200, { killSwitch: swarm.isKilled() });
    }
    if (req.method === "POST" && path === "/admin/archive") {
      const agentId = String(body.agentId ?? "");
      if (!/^a[a-f0-9]{16}$/.test(agentId)) return send(res, 400, { error: "agentId is required." });
      await swarm.archiveAgent(agentId, body.reason ? String(body.reason) : "Archived by admin.");
      return send(res, 200, { ok: true, agentId });
    }
    if (req.method === "POST" && path === "/admin/clock") {
      const advanced = await swarm.advance(Number(body.advanceMs ?? 0));
      if (!advanced.ok) return send(res, 400, { error: advanced.error });
      return send(res, 200, advanced.value);
    }
    if (req.method === "POST" && path === "/admin/simulate-transfer") {
      const from = String(body.from ?? "0x2222222222222222222222222222222222222222");
      const tx = String(body.txHash ?? `sim-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const result = await swarm.simulateTransfer(String(body.agentId ?? ""), from, parseUsd(String(body.usd ?? "")), tx);
      if (!result.ok) return send(res, 400, { error: result.error });
      return send(res, 200, result.value);
    }
    if (req.method === "POST" && path === "/admin/faucet") {
      if (config.moneyMode !== "dry-run") return send(res, 400, { error: "The faucet exists only in dry-run." });
      return send(res, 400, { error: "Fund an agent with simulate-transfer, or top up the ledger." });
    }
    return send(res, 404, { error: "Unknown admin route." });
  }

  const internal = /^\/internal\/agents\/(a[a-f0-9]+)(\/snapshot|\/infer|\/tool|\/turn|\/refusal)$/.exec(path);
  if (internal) {
    const agentId = internal[1];
    const token = bearer(req);
    if (!swarm.checkToken(agentId, token)) return send(res, 401, { error: "Agent token rejected." });
    if (req.method === "GET" && internal[2] === "/snapshot") {
      try {
        return send(res, 200, await host.snapshot(agentId));
      } catch {
        return send(res, 404, { error: "Unknown agent." });
      }
    }
    const body = await readJson(req);
    if (req.method === "POST" && internal[2] === "/infer") {
      const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
      const tools = Array.isArray(body.tools) ? body.tools : [];
      return send(res, 200, await host.infer(agentId, messages, tools));
    }
    if (req.method === "POST" && internal[2] === "/tool") {
      return send(res, 200, await host.authorizeTool(agentId, body.call as ToolCall));
    }
    if (req.method === "POST" && internal[2] === "/turn") {
      await host.recordTurn(agentId, String(body.text ?? ""));
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && internal[2] === "/refusal") {
      await host.recordRefusal(agentId, String(body.tool ?? ""), String(body.rule ?? ""), String(body.reason ?? ""));
      return send(res, 200, { ok: true });
    }
  }
  send(res, 404, { error: "Not found." });
}

/**
 * The public listener (specs/BO-4.3): only the agent routes, served by the same code as on the main listener. Every other
 * path is a plain 404, decided before any other route is considered.
 */
async function handlePublic(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  swarm: Swarm,
  handlers: HandlerSandbox,
  gate: BuyerGate | undefined,
): Promise<void> {
  const path = (req.url ?? "/").split("?")[0] || "/";
  const agentRoute = classifyAgentRoute(path);
  if (agentRoute.kind === "no") return send(res, 404, { error: "Not found." });
  return serveAgentRoute(req, res, agentRoute, config, swarm, handlers, gate);
}

const NOT_ALLOWLISTED = "Buyer wallet is not allowlisted for this testnet test.";

async function serveAgentRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: Exclude<AgentRoute, { kind: "no" }>,
  config: AppConfig,
  swarm: Swarm,
  handlers: HandlerSandbox,
  gate: BuyerGate | undefined,
): Promise<void> {
  if (route.kind === "refuse") return send(res, 400, { error: "Path is refused." });
  if (route.kind === "legacy") {
    if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "Method not allowed." });
    return servePaid(req, res, config, swarm, route.agentId, gate);
  }
  if (route.kind === "index") {
    if (req.method !== "GET") return send(res, 405, { error: "Method not allowed." });
    return servePageIndex(res, swarm, route.agentId);
  }
  return serveNamed(req, res, config, swarm, handlers, route.agentId, route.name, gate);
}

async function servePaid(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  swarm: Swarm,
  agentId: string,
  gate: BuyerGate | undefined,
): Promise<void> {
  const service = swarm.service(agentId);
  const snapshot = swarm.overview().agents.find((agent) => agent.id === agentId);
  if (!service || !snapshot) return send(res, 404, { error: "No paid service is offered here." });
  const signatureHeader = req.headers["payment-signature"];
  const payment = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  const challenge = paymentRequirements({
    config,
    payTo: snapshot.walletAddress as `0x${string}`,
    amountUnits: BigInt(service.priceUnits),
    resource: `/a/${agentId}`,
    description: service.description,
  });
  if (!payment) {
    writePaymentRequired(res, challenge);
    return;
  }
  let body = "";
  let txHash: string | undefined;
  if (!gate) {
    const settled = await swarm.settleDryPayment(agentId, payment);
    if (!settled.ok) return send(res, 402, { error: settled.error });
    body = settled.value.body;
    txHash = settled.value.txHash;
  } else {
    // The allow-list must sit between verify and commit, so the single settle call is split here (same steps as settleDryPayment).
    const verified = await swarm.verifyInboundPayment(agentId, payment, service.priceUnits);
    if (!verified.ok) return send(res, 402, { error: verified.error });
    try {
      if (!gate(verified.value.from)) return send(res, 403, { error: NOT_ALLOWLISTED });
      const settled = await swarm.commitInboundPayment(agentId, verified.value);
      if (!settled.ok) return send(res, 402, { error: settled.error });
      body = service.body;
      txHash = settled.value.txHash;
    } finally {
      swarm.releaseInboundPayment(verified.value.nonce);
    }
  }
  const receipt = { success: true, transaction: txHash ?? "", network: caipNetwork(config) };
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    [X402_HEADERS.response]: encodeHeaderValue(receipt),
    "Access-Control-Expose-Headers": `${X402_HEADERS.required}, ${X402_HEADERS.response}`,
    "X-Automaton-Disclosure": "This response was produced by an AI agent, not a human.",
  });
  res.end(body);
}

function servePageIndex(res: ServerResponse, swarm: Swarm, agentId: string): void {
  try {
    swarm.snapshot(agentId);
  } catch {
    send(res, 404, { error: "Unknown agent." });
    return;
  }
  const slugs = swarm.listPages(agentId).map((page) => page.slug);
  const endpoints = swarm
    .listEndpoints(agentId)
    .filter((endpoint) => endpoint.status === "live" && endpoint.lastTestOutput)
    .map((endpoint) => ({ name: endpoint.name, price: formatUsd(endpoint.priceUnits), lastTestOutput: endpoint.lastTestOutput ?? "" }));
  sendHtml(res, renderPageIndex(agentId, slugs, endpoints));
}

async function serveNamed(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  swarm: Swarm,
  handlers: HandlerSandbox,
  agentId: string,
  name: string,
  gate: BuyerGate | undefined,
): Promise<void> {
  let walletAddress = "";
  let status = "";
  try {
    const snapshot = swarm.snapshot(agentId);
    walletAddress = snapshot.walletAddress;
    status = snapshot.status;
  } catch {
    send(res, 404, { error: "Unknown agent." });
    return;
  }
  const endpoint = swarm.endpoint(agentId, name);
  if (endpoint) {
    // An endpoint that failed its re-tests is off sale: 404 before any payment challenge or payment check.
    if (status === "archived" || endpoint.status === "unpublished") {
      return send(res, 404, { error: "No paid endpoint is offered here." });
    }
    if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "Method not allowed." });
    return serveEndpoint(req, res, config, swarm, handlers, agentId, name, walletAddress, endpoint, gate);
  }
  if (req.method !== "GET") return send(res, 405, { error: "Method not allowed." });
  const page = swarm.page(agentId, name);
  if (!page) return send(res, 404, { error: "No page is published here." });
  sendHtml(res, renderPublishedPage(agentId, name, page.markdown));
}

async function serveEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  swarm: Swarm,
  handlers: HandlerSandbox,
  agentId: string,
  name: string,
  walletAddress: string,
  endpoint: ServedEndpoint,
  gate: BuyerGate | undefined,
): Promise<void> {
  const body = await readRaw(req, 64 * 1024);
  if (!body.ok) return send(res, 413, { error: body.error });
  const signatureHeader = req.headers["payment-signature"];
  const payment = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  const challenge = paymentRequirements({
    config,
    payTo: walletAddress as `0x${string}`,
    amountUnits: BigInt(endpoint.priceUnits),
    resource: `/a/${agentId}/${name}`,
    description: `Paid endpoint ${name}`,
  });
  if (!payment) {
    writePaymentRequired(res, challenge);
    return;
  }
  const verified = await swarm.verifyInboundPayment(agentId, payment, endpoint.priceUnits);
  if (!verified.ok) return send(res, 402, { error: verified.error });
  if (gate && !gate(verified.value.from)) {
    // Before the handler runs and before any money moves. The held nonce is pending only, so it is dropped.
    swarm.releaseInboundPayment(verified.value.nonce);
    return send(res, 403, { error: NOT_ALLOWLISTED });
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key) || value.length > 2_000) continue;
    if (query[key] !== undefined) continue;
    query[key] = value;
  }
  try {
    const ran = await handlers.run({
      snapshotHash: endpoint.snapshotHash,
      stdin: JSON.stringify({ method: req.method ?? "GET", path: `/a/${agentId}/${name}`, query, body: body.text }),
    });
    if (!ran.ok) {
      swarm.recordEndpointCall({
        agentId,
        endpoint: name,
        priceUnits: endpoint.priceUnits,
        outcome: ran.code,
        durationMs: ran.durationMs,
        bytesOut: ran.bytesOut,
        failed: ran.code !== "busy",
      });
      return send(res, handlerHttpStatus(ran.code), { error: ran.publicReason });
    }
    const settled = await swarm.commitInboundPayment(agentId, verified.value);
    if (!settled.ok) {
      swarm.recordEndpointCall({
        agentId,
        endpoint: name,
        priceUnits: endpoint.priceUnits,
        outcome: "settlement",
        durationMs: ran.durationMs,
        bytesOut: ran.bytesOut,
        failed: true,
      });
      return send(res, 502, { error: "Settlement failed. The buyer was not charged." });
    }
    swarm.recordEndpointCall({
      agentId,
      endpoint: name,
      priceUnits: endpoint.priceUnits,
      outcome: "ok",
      durationMs: ran.durationMs,
      bytesOut: ran.bytesOut,
      failed: false,
    });
    const receipt = { success: true, transaction: settled.value.txHash ?? "", network: caipNetwork(config) };
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      [X402_HEADERS.response]: encodeHeaderValue(receipt),
      "Access-Control-Expose-Headers": `${X402_HEADERS.required}, ${X402_HEADERS.response}`,
      "X-Automaton-Disclosure": "This response was produced by an AI agent, not a human.",
    });
    res.end(ran.output);
  } finally {
    // Pending only. A committed nonce is status=used and is not deleted.
    swarm.releaseInboundPayment(verified.value.nonce);
  }
}

function writePaymentRequired(res: ServerResponse, challenge: Record<string, unknown>): void {
  res.writeHead(402, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    [X402_HEADERS.required]: encodeHeaderValue(challenge),
    "Access-Control-Expose-Headers": `${X402_HEADERS.required}, ${X402_HEADERS.response}`,
    "X-Automaton-Disclosure": "This response was produced by an AI agent, not a human.",
  });
  res.end(JSON.stringify(challenge));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
  });
  res.end(html);
}

function adminOk(req: IncomingMessage, expected: string): boolean {
  const header = req.headers["x-admin-token"];
  const got = Array.isArray(header) ? header[0] : header ?? "";
  if (!expected || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}

async function readRaw(req: IncomingMessage, limit: number): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) return { ok: false, error: "Request body is too large." };
    chunks.push(buffer);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256_000) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required.");
  return parsed as Record<string, unknown>;
}
