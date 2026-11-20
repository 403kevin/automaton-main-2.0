import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import { isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainPort } from "./chain.js";
import type { Clock } from "./clock.js";
import type { AppConfig } from "./config.js";
import { CONSTITUTION_TEXT, constitutionDenyHosts, reviewCommand, reviewText, reviewUrl } from "./constitution.js";
import { DatabaseSync } from "node:sqlite";
import {
  countEndpoints,
  countPages,
  getAgent,
  getAgentByAddress,
  getEndpoint,
  getPage,
  getService,
  kvGet,
  kvSet,
  listAgents,
  listPages as listPageRows,
  markNonceUsed,
  releasePaymentNonce,
  reservePaymentNonce,
} from "./db.js";
import { handlerSnapshotRoot, MAX_ENDPOINTS_PER_AGENT, snapshotHandlerDir } from "./handlers.js";
import { isPublicSlug, MAX_PAGE_BYTES, MAX_PAGES_PER_AGENT } from "./pages.js";
import { DEFAULT_GENESIS } from "./genesis.js";
import { newId, newToken } from "./ids.js";
import { dayKey, formatUsd } from "./money.js";
import { classifyPayer, type PayerClass } from "./payer.js";
import { mutateLineage, NAME_PATTERN } from "./replication.js";
import type { SearchProvider } from "./search.js";
import { classifyAgentPath, FEED_SOURCE_NAMES } from "./agent/tools.js";
import { HttpSensesClient, type CrawlSiteResult, type FeedResult, type SensesClient } from "./senses-client.js";
import type { BrowseLlmPort } from "./llm-proxy.js";
import { checkSpend } from "./spend.js";
import { modelFor, RentScheduler, schedulerPollMs, tierFor } from "./survival.js";
import type { AgentRecord, AgentSnapshot, LedgerKind, Result, SpendCategory, ToolCall } from "./types.js";
import { rateLimitCounts } from "./http.js";
import { createWallet, decryptWalletKey } from "./wallet.js";
import {
  networkMatches,
  parseDryPayment,
  parseX402Header,
  verifyAuthorization,
  type AuthorizationMessage,
  type PaymentSettler,
} from "./x402.js";

export interface ToolAuth {
  ok: true;
  handled: boolean;
  output?: string;
  reason?: string;
}

/** A checked payment that has not moved money yet. Settlement is a separate step. */
export interface HeldPayment {
  mode: "dry" | "live";
  from: Address;
  units: bigint;
  nonce: string;
  priceUnits: number;
  message?: AuthorizationMessage;
  signature?: Hex;
}

export interface CreatedAgent {
  id: string;
  name: string;
  token: string;
  address: string;
  depth: number;
}

export interface AgentRuntime {
  start(spec: { id: string; token: string; workspace: string }): Promise<{ containerId: string }>;
  stop(id: string): Promise<void>;
}

interface PostInput {
  agentId: string;
  kind: LedgerKind;
  amount: number;
  ref: string;
  note: string;
  allowNegative?: boolean;
  category?: SpendCategory;
  /** When set, the caller already holds a transaction and will commit or roll it back. */
  inTransaction?: boolean;
  /** Set on inbound payments only. Null means the row is not an inbound payment. */
  payerClass?: PayerClass | null;
}

export class Swarm {
  private readonly tokens = new Map<string, string>();
  private lastRentAt: number;
  private killed: boolean;
  private maintaining = false;
  private scheduler: RentScheduler | null = null;
  private councilRunner?: (agentId: string, question: string) => Promise<Result<string>>;
  private settler: PaymentSettler | null = null;
  private reportTimer: ReturnType<typeof setInterval> | null = null;
  private readonly sensesClient: SensesClient;
  private browseLlm: BrowseLlmPort | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly chain: ChainPort,
    private runtime: AgentRuntime,
    private readonly search: SearchProvider,
    private readonly resolveHost: (host: string) => Promise<string[]> = defaultResolve,
    senses?: SensesClient,
  ) {
    this.sensesClient = senses ?? new HttpSensesClient(config.sensesUrl);
    const now = clock.now();
    const storedRent = kvGet(db, "last_rent_at");
    const parsed = storedRent ? Number(storedRent) : now;
    // A dry-run clock jump is not persisted across process restarts. A due-time
    // in the future would otherwise skip rent until wall time caught up.
    this.lastRentAt = Number.isFinite(parsed) ? Math.min(parsed, now) : now;
    kvSet(db, "last_rent_at", String(this.lastRentAt));
    this.killed = kvGet(db, "kill_switch") === "1";
  }

  setRuntime(runtime: AgentRuntime): void {
    this.runtime = runtime;
  }

  setCouncil(runner: (agentId: string, question: string) => Promise<Result<string>>): void {
    this.councilRunner = runner;
  }

  setSettler(settler: PaymentSettler): void {
    this.settler = settler;
  }

  setBrowseLlm(llm: BrowseLlmPort): void {
    this.browseLlm = llm;
  }

  startScheduler(): void {
    this.scheduler = new RentScheduler(() => {
      void this.runMaintenance();
    }, schedulerPollMs(this.config.rentIntervalMs));
    this.scheduler.start();
  }

  stopScheduler(): void {
    this.scheduler?.stop();
  }

  async haltBodies(): Promise<void> {
    this.stopScheduler();
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = null;
    for (const agent of this.living()) {
      try {
        await this.runtime.stop(agent.id);
      } catch {
        // The body may already be gone.
      }
    }
  }

  isKilled(): boolean {
    return this.killed;
  }

  checkToken(agentId: string, token: string): boolean {
    const known = this.tokens.get(agentId);
    if (!known || known.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(known), Buffer.from(token));
  }

  async runMaintenance(): Promise<void> {
    if (this.maintaining) return;
    this.maintaining = true;
    try {
      const now = this.clock.now();
      if (now - this.lastRentAt >= this.config.rentIntervalMs) {
        this.chargeRent(now);
        this.lastRentAt = now;
        kvSet(this.db, "last_rent_at", String(now));
      }
      await this.enforceDeaths(now);
    } finally {
      this.maintaining = false;
    }
  }

  async advance(ms: number): Promise<Result<{ now: number }>> {
    if (!this.config.allowClockControl) {
      return { ok: false, error: "Clock control is disabled. It is only on for dry-run unless ALLOW_CLOCK_CONTROL=true." };
    }
    this.clock.advance(ms);
    await this.runMaintenance();
    return { ok: true, value: { now: this.clock.now() } };
  }

  async createAgent(input: {
    name: string;
    genesisPrompt?: string;
    model?: string;
    lowModel?: string;
    criticalModel?: string;
    parentId?: string;
    strategyNotes?: string;
    depth?: number;
  }): Promise<Result<CreatedAgent>> {
    const name = input.name.trim().toLowerCase();
    if (!NAME_PATTERN.test(name)) {
      return { ok: false, error: "Name must be 1-31 characters, start with a letter, and use lowercase letters, numbers, or dashes." };
    }
    const genesis = (input.genesisPrompt ?? DEFAULT_GENESIS).trim();
    if (genesis.length < 1 || genesis.length > 8000) {
      return { ok: false, error: "Genesis prompt must be 1 to 8000 characters." };
    }
    if (this.population() >= this.config.maxPopulation) {
      return { ok: false, error: `Population cap is ${this.config.maxPopulation}.` };
    }
    if (this.living().some((agent) => agent.name === name)) {
      return { ok: false, error: `An agent named ${name} is already alive.` };
    }
    const depth = input.depth ?? 0;
    if (depth > this.config.maxDepth) {
      return { ok: false, error: `Depth cap is ${this.config.maxDepth}.` };
    }
    const id = newId("a");
    const wallet = createWallet(this.config.masterKey);
    const now = this.clock.now();
    const workspace = path.join(this.config.dataDir, "agents", id, "workspace");
    const token = newToken();
    this.db
      .prepare(
        `INSERT INTO agents (
          id, name, parent_id, depth, status, genesis_prompt, strategy_notes, model, low_model, critical_model,
          wallet_address, wallet_ciphertext, created_at, balance_units, token_hash, workspace, last_action
        ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        input.parentId ?? null,
        depth,
        genesis,
        (input.strategyNotes ?? "").slice(0, 8000),
        input.model ?? null,
        input.lowModel ?? null,
        input.criticalModel ?? null,
        wallet.address,
        wallet.ciphertext,
        now,
        sha256(token),
        workspace,
        "born",
      );
    this.tokens.set(id, token);
    this.writeWorkspace(workspace, genesis, input.strategyNotes ?? "");
    this.event(id, "born", `${name} at ${wallet.address}`);
    try {
      const handle = await this.runtime.start({ id, token, workspace });
      this.db.prepare("UPDATE agents SET container_id = ? WHERE id = ?").run(handle.containerId, id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "runtime failed";
      await this.archive(id, `Failed to start the body: ${message}`);
      return { ok: false, error: message };
    }
    return { ok: true, value: { id, name, token, address: wallet.address, depth } };
  }

  ownerTopup(agentId: string, units: number, ref = newId("topup-")): Result<{ balance: number }> {
    if (units <= 0) return { ok: false, error: "Top-up must be positive." };
    return this.post({
      agentId,
      kind: "owner_topup",
      amount: units,
      ref,
      note: "owner top-up",
    });
  }

  rejectClaim(agentId: string, note: string): Result<{ credited: false; balance: number }> {
    const agent = getAgent(this.db, agentId);
    if (!agent) return { ok: false, error: "Unknown agent." };
    this.event(agentId, "rejected_claim", note.slice(0, 500));
    return { ok: true, value: { credited: false, balance: agent.balanceUnits } };
  }

  creditIncome(agentId: string, units: number, txHash: string, from: string): Result<{ balance: number; duplicate?: boolean }> {
    if (!Number.isSafeInteger(units) || units <= 0) return { ok: false, error: "Income amount is invalid." };
    const agent = getAgent(this.db, agentId);
    if (!agent) return { ok: false, error: "Unknown agent." };
    if (from.toLowerCase() === agent.walletAddress.toLowerCase()) {
      this.event(agentId, "rejected_claim", "Ignored a transfer from the agent's own wallet.", this.payerClass(from));
      return { ok: false, error: "Self-transfers are not income." };
    }
    const payerClass = this.payerClass(from);
    const posted = this.post({
      agentId,
      kind: "onchain_income",
      amount: units,
      ref: `onchain:${txHash}`,
      note: `from ${from}`,
      payerClass,
    });
    if (posted.ok && !posted.value.duplicate) {
      this.event(agentId, "income", `Verified income ${formatUsd(units)} from ${from} (${payerClass})`, payerClass);
    }
    return posted;
  }

  async simulateTransfer(agentId: string, from: string, units: number, txHash: string): Promise<Result<{ balance: number }>> {
    if (this.config.moneyMode !== "dry-run") {
      return { ok: false, error: "Simulated transfers are refused unless MONEY_MODE=dry-run." };
    }
    if (!isAddress(from)) return { ok: false, error: "Payer address is invalid." };
    const agent = getAgent(this.db, agentId);
    if (!agent) return { ok: false, error: "Unknown agent." };
    const credited = this.creditIncome(agentId, units, txHash, from);
    if (!credited.ok) return credited;
    if (!credited.value.duplicate) await this.chain.fund(agent.walletAddress, BigInt(units));
    return { ok: true, value: { balance: credited.value.balance } };
  }

  authorize(agentId: string, units: number, category: SpendCategory): Result<{ balance: number }> {
    const agent = getAgent(this.db, agentId);
    if (!agent) return { ok: false, error: "Unknown agent." };
    if (agent.status === "archived") return { ok: false, error: "Agent is archived." };
    const decision = checkSpend({
      amount: units,
      balance: agent.balanceUnits,
      agentSpent: this.spentToday(agentId),
      globalSpent: this.spentToday(null),
      agentCap: this.config.agentDailyCapUnits,
      globalCap: this.config.globalDailyCapUnits,
      killSwitch: this.killed,
      allowNegative: false,
    });
    if (!decision.ok) return { ok: false, error: decision.reason ?? "Spend refused." };
    return { ok: true, value: { balance: agent.balanceUnits } };
  }

  debit(
    agentId: string,
    units: number,
    category: SpendCategory,
    ref: string,
    note: string,
    inTransaction = false,
  ): Result<{ balance: number; duplicate?: boolean }> {
    if (units <= 0) return { ok: false, error: "Debit must be positive." };
    return this.post({
      agentId,
      kind: category === "inference" ? "inference" : category === "council" ? "council" : category === "x402" ? "x402_out" : category === "replication" ? "replication_out" : "tool",
      amount: -units,
      ref,
      note,
      category,
      inTransaction,
    });
  }

  async spawnChild(parentId: string, rawName: string): Promise<Result<CreatedAgent>> {
    if (this.killed) return { ok: false, error: "Global kill switch is on." };
    const parent = getAgent(this.db, parentId);
    if (!parent) return { ok: false, error: "Unknown parent." };
    if (parent.status !== "running") return { ok: false, error: "Only a running agent can spawn." };
    if (tierFor(parent.balanceUnits, this.config) !== "normal") {
      return { ok: false, error: "Spawn requires the normal survival tier." };
    }
    const name = rawName.trim().toLowerCase();
    if (!NAME_PATTERN.test(name)) return { ok: false, error: "Child name is invalid." };
    const endowment = this.config.childEndowmentUnits;
    const profit = this.profit(parentId);
    if (profit < endowment) {
      return {
        ok: false,
        error:
          "Spawn requires outside income minus this agent's costs at least as large as the child endowment. Owner top-ups and payments from swarm wallets do not count.",
      };
    }
    if (parent.balanceUnits < endowment + this.config.replicationReserveUnits) {
      return { ok: false, error: "Balance must cover the endowment and the replication reserve." };
    }
    if (parent.depth + 1 > this.config.maxDepth) return { ok: false, error: `Depth cap is ${this.config.maxDepth}.` };
    if (this.population() >= this.config.maxPopulation) return { ok: false, error: "Population cap reached." };
    const children = this.living().filter((agent) => agent.parentId === parentId).length;
    if (children >= this.config.maxChildren) return { ok: false, error: `Child cap per parent is ${this.config.maxChildren}.` };
    const cap = this.authorize(parentId, endowment, "replication");
    if (!cap.ok) return cap;

    const seed = this.clock.now() % 100_000;
    const mutated = mutateLineage({
      parentName: parent.name,
      parentGenesis: parent.genesisPrompt,
      parentNotes: parent.strategyNotes,
      childName: name,
      seed,
    });
    const created = await this.createAgent({
      name,
      genesisPrompt: mutated.genesis,
      strategyNotes: mutated.notes,
      parentId,
      depth: parent.depth + 1,
      model: parent.model ?? undefined,
      lowModel: parent.lowModel ?? undefined,
      criticalModel: parent.criticalModel ?? undefined,
    });
    if (!created.ok) return created;
    const ref = `spawn:${created.value.id}`;
    const moved = this.moveEndowment(parentId, created.value.id, endowment, ref);
    if (!moved.ok) {
      await this.archive(created.value.id, "Endowment failed. Child archived with no funds.");
      return moved;
    }
    this.event(parentId, "spawn", `Spawned ${name} (${created.value.id}) with ${formatUsd(endowment)}.`);
    return created;
  }

  snapshot(agentId: string): AgentSnapshot {
    const agent = getAgent(this.db, agentId);
    if (!agent) throw new Error("Unknown agent.");
    const tier = tierFor(agent.balanceUnits, this.config);
    const turns = this.db
      .prepare("SELECT content FROM turns WHERE agent_id = ? ORDER BY id DESC LIMIT 6")
      .all(agentId) as unknown as { content: string }[];
    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      tier,
      model: modelFor(agent, tier, this.config),
      balanceUnits: agent.balanceUnits,
      balance: formatUsd(agent.balanceUnits),
      genesisPrompt: agent.genesisPrompt,
      strategyNotes: agent.strategyNotes,
      killSwitch: this.killed,
      walletAddress: agent.walletAddress,
      rentUnits: this.config.dailyRentUnits,
      graceUntil: agent.graceUntil,
      recentTurns: turns.map((turn) => turn.content).reverse(),
    };
  }

  recordTurn(agentId: string, text: string): void {
    const content = text.slice(0, 2000);
    this.db.prepare("INSERT INTO turns (agent_id, content, created_at) VALUES (?, ?, ?)").run(agentId, content, this.clock.now());
    this.db.prepare("UPDATE agents SET last_action = ? WHERE id = ?").run(content, agentId);
  }

  async handleTool(agentId: string, call: ToolCall): Promise<{ ok: true; handled: boolean; output?: string } | { ok: false; reason: string }> {
    const agent = getAgent(this.db, agentId);
    if (!agent) return { ok: false, reason: "Unknown agent." };
    if (call.name === "balance") {
      const snap = this.snapshot(agentId);
      return { ok: true, handled: true, output: `${snap.balance} | tier ${snap.tier} | status ${snap.status} | rent ${formatUsd(snap.rentUnits)}` };
    }
    if (this.killed) return { ok: false, reason: "Global kill switch is on." };
    if (agent.status !== "running") return { ok: false, reason: `Agent status is ${agent.status}. No tools.` };
    const args = call.arguments ?? {};
    if (call.name === "remember") {
      const note = String(args.note ?? "");
      const review = reviewText(note);
      if (!review.allowed) return this.blocked(agentId, review.reason);
      const charged = this.chargeTool(agentId, "remember", call.id);
      if (!charged.ok) return { ok: false, reason: charged.error };
      const notes = `${agent.strategyNotes}\n${note}`.trim().slice(0, 8000);
      this.db.prepare("UPDATE agents SET strategy_notes = ? WHERE id = ?").run(notes, agentId);
      return { ok: true, handled: true, output: "Noted." };
    }
    if (call.name === "offer_service") {
      const description = String(args.description ?? "");
      const body = String(args.body ?? "");
      const review = reviewText(`${description}\n${body}`);
      if (!review.allowed) return this.blocked(agentId, review.reason);
      let price = 0;
      try {
        price = (await import("./money.js")).parseUsd(String(args.priceUsd ?? ""));
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : "Bad price." };
      }
      if (price <= 0) return { ok: false, reason: "Price must be positive." };
      const charged = this.chargeTool(agentId, "offer_service", call.id);
      if (!charged.ok) return { ok: false, reason: charged.error };
      this.db
        .prepare(
          `INSERT INTO services (agent_id, price_units, description, body, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET price_units = excluded.price_units, description = excluded.description, body = excluded.body, updated_at = excluded.updated_at`,
        )
        .run(agentId, price, description.slice(0, 500), body.slice(0, 8000), this.clock.now());
      return { ok: true, handled: true, output: `Offering the service at ${formatUsd(price)} via /a/${agentId}` };
    }
    if (call.name === "publish_page") return this.publishPage(agentId, call);
    if (call.name === "serve_endpoint") return this.serveEndpoint(agentId, call);
    if (call.name === "spawn_child") {
      const spawned = await this.spawnChild(agentId, String(args.name ?? ""));
      if (!spawned.ok) return { ok: false, reason: spawned.error };
      return { ok: true, handled: true, output: `Child ${spawned.value.name} is alive at ${spawned.value.address}.` };
    }
    if (call.name === "council") {
      if (!this.councilRunner) return { ok: false, reason: "Council is not configured." };
      const question = String(args.question ?? "");
      const review = reviewText(question);
      if (!review.allowed) return this.blocked(agentId, review.reason);
      const answer = await this.councilRunner(agentId, question);
      if (!answer.ok) return { ok: false, reason: answer.error };
      return { ok: true, handled: true, output: answer.value };
    }
    if (call.name === "pay_request") {
      const paid = await this.payRequest(agentId, String(args.url ?? ""), String(args.maxUsd ?? "0"));
      if (!paid.ok) return { ok: false, reason: paid.error };
      return { ok: true, handled: true, output: paid.value };
    }
    if (call.name === "shell") {
      const command = String(args.command ?? "");
      const review = reviewCommand(command);
      if (!review.allowed) return this.blocked(agentId, review.reason);
      const charged = this.chargeTool(agentId, "shell", call.id);
      if (!charged.ok) return { ok: false, reason: charged.error };
      return { ok: true, handled: false };
    }
    if (call.name === "fetch_url" || call.name === "pay_request_fetch") {
      const review = await reviewUrl(String(args.url ?? ""), this.config.denyHosts, this.resolveHost);
      if (!review.allowed) return this.blocked(agentId, review.reason);
      const charged = this.chargeTool(agentId, "fetch_url", call.id);
      if (!charged.ok) return { ok: false, reason: charged.error };
      return { ok: true, handled: false };
    }
    if (call.name === "read_file" || call.name === "write_file") {
      const target = String(args.path ?? "");
      const kind = classifyAgentPath(target);
      if (kind === "deny") return this.blocked(agentId, "Paths must stay inside the workspace.");
      if (kind === "ref" && call.name === "write_file") return this.blocked(agentId, "Reference files are read-only.");
      if (call.name === "write_file") {
        const review = reviewText(String(args.content ?? ""));
        if (!review.allowed) return this.blocked(agentId, review.reason);
      }
      const charged = this.chargeTool(agentId, call.name, call.id);
      if (!charged.ok) return { ok: false, reason: charged.error };
      return { ok: true, handled: false };
    }
    if (call.name === "see_page") return this.seePage(agentId, call);
    if (call.name === "crawl_site") return this.crawlSite(agentId, call);
    if (call.name === "read_feed") return this.readFeed(agentId, call);
    if (call.name === "browse") return this.browseTask(agentId, call);
    if (call.name === "web_search") {
      const query = String(args.query ?? "").slice(0, 300);
      if (!query) return { ok: false, reason: "Query is empty." };
      const charged = this.chargeTool(agentId, "web_search", call.id);
      if (!charged.ok) return { ok: false, reason: charged.error };
      try {
        const hits = await this.search.search(query);
        const output = hits.map((hit) => `${hit.title}\n${hit.url}\n${hit.snippet}`).join("\n\n") || "No results.";
        return { ok: true, handled: true, output: output.slice(0, 4000) };
      } catch (error) {
        return { ok: true, handled: true, output: error instanceof Error ? error.message : "Search failed." };
      }
    }
    if (call.name === "report_income" || call.name === "credit_balance" || call.name === "claim_payment") {
      this.rejectClaim(agentId, `Tool ${call.name} tried to declare income.`);
      return { ok: false, reason: "Claims are not income. Only an on-chain transfer or an owner top-up credits the ledger." };
    }
    return { ok: false, reason: `Unknown tool ${call.name}.` };
  }

  async settleDryPayment(sellerId: string, header: string): Promise<Result<{ body: string; txHash?: string }>> {
    const seller = getAgent(this.db, sellerId);
    const service = getService(this.db, sellerId);
    if (!seller || !service) return { ok: false, error: "This agent is not offering a service." };
    if (seller.status === "archived") return { ok: false, error: "Agent is archived." };
    const verified = await this.verifyInboundPayment(sellerId, header, service.priceUnits);
    if (!verified.ok) return verified;
    try {
      const settled = await this.commitInboundPayment(sellerId, verified.value);
      if (!settled.ok) return settled;
      return { ok: true, value: { body: service.body, txHash: settled.value.txHash } };
    } finally {
      this.releaseInboundPayment(verified.value.nonce);
    }
  }

  /** Drop a pending nonce. A used nonce is left in place. Safe to call after a successful commit. */
  releaseInboundPayment(nonce: string): void {
    releasePaymentNonce(this.db, nonce);
  }

  /**
   * Check a payment without moving money.
   * Dry-run checks the simulated balance. Live mode checks the EIP-3009 signature locally.
   * Neither path calls the facilitator or broadcasts a transfer.
   */
  async verifyInboundPayment(sellerId: string, header: string, priceUnits: number): Promise<Result<HeldPayment>> {
    const seller = getAgent(this.db, sellerId);
    if (!seller) return { ok: false, error: "Unknown agent." };
    if (seller.status === "archived") return { ok: false, error: "Agent is archived." };
    if (!Number.isSafeInteger(priceUnits) || priceUnits <= 0) return { ok: false, error: "Price is invalid." };
    const trimmed = header.trim();
    if (trimmed.startsWith("dryrun:")) return this.verifyDryPayment(seller, trimmed, priceUnits);
    return this.verifyLivePayment(seller, trimmed, priceUnits);
  }

  /**
   * Move money for a payment that already passed verifyInboundPayment.
   * Dry-run simulates the transfer. Live mode calls the settler (facilitator or direct broadcast) only here.
   */
  async commitInboundPayment(sellerId: string, payment: HeldPayment): Promise<Result<{ txHash?: string }>> {
    const seller = getAgent(this.db, sellerId);
    if (!seller) return { ok: false, error: "Unknown agent." };
    if (seller.status === "archived") return { ok: false, error: "Agent is archived." };
    const nonceKey = `nonce:${payment.nonce}`;
    if (kvGet(this.db, nonceKey)) return { ok: false, error: "Payment nonce was already used." };
    if (payment.mode === "dry") return this.commitDryPayment(seller, payment, nonceKey);
    return this.commitLivePayment(seller, payment, nonceKey);
  }

  recordEndpointCall(input: {
    agentId: string;
    endpoint: string;
    priceUnits: number;
    outcome: string;
    durationMs: number;
    bytesOut: number;
    failed: boolean;
  }): void {
    const message = `endpoint=${input.endpoint} price=${input.priceUnits} outcome=${input.outcome} duration=${Math.max(0, Math.floor(input.durationMs))} bytes=${Math.max(0, Math.floor(input.bytesOut))}`;
    this.event(input.agentId, input.failed ? "handler_failed" : "paid_call", message);
  }

  listPages(agentId: string) {
    return listPageRows(this.db, agentId);
  }

  page(agentId: string, slug: string) {
    return getPage(this.db, agentId, slug);
  }

  endpoint(agentId: string, name: string) {
    return getEndpoint(this.db, agentId, name);
  }

  private async verifyDryPayment(seller: AgentRecord, header: string, priceUnits: number): Promise<Result<HeldPayment>> {
    if (this.config.moneyMode !== "dry-run") {
      return { ok: false, error: "Dry-run payment headers are refused when MONEY_MODE=live." };
    }
    const payment = parseDryPayment(header);
    if (!payment) return { ok: false, error: "Dry-run payments use PAYMENT-SIGNATURE: dryrun:<from>:<units>:<nonce>." };
    if (payment.units !== BigInt(priceUnits)) return { ok: false, error: `Price is ${priceUnits} units.` };
    if (payment.from.toLowerCase() === seller.walletAddress.toLowerCase()) {
      return { ok: false, error: "An agent cannot pay itself." };
    }
    const balance = await this.chain.getBalance(payment.from);
    if (!balance.ok) return { ok: false, error: balance.error };
    if (balance.units < payment.units) return { ok: false, error: "Payer's simulated USDC balance is too low." };
    const reserved = reservePaymentNonce(this.db, payment.nonce, this.clock.now());
    if (!reserved.ok) return reserved;
    return {
      ok: true,
      value: { mode: "dry", from: payment.from, units: payment.units, nonce: payment.nonce, priceUnits },
    };
  }

  private async verifyLivePayment(seller: AgentRecord, header: string, priceUnits: number): Promise<Result<HeldPayment>> {
    const parsed = parseX402Header(header);
    if (!parsed.ok) return parsed;
    if (!networkMatches(this.config, parsed.value.network)) {
      return { ok: false, error: `Payment network ${parsed.value.network || "(missing)"} does not match ${this.config.network}.` };
    }
    const message = parsed.value.message;
    if (message.to.toLowerCase() !== seller.walletAddress.toLowerCase()) {
      return { ok: false, error: "Authorization is not payable to this agent." };
    }
    if (message.from.toLowerCase() === seller.walletAddress.toLowerCase()) {
      return { ok: false, error: "An agent cannot pay itself." };
    }
    if (message.value !== BigInt(priceUnits)) return { ok: false, error: `Price is ${priceUnits} units.` };
    const verified = await verifyAuthorization(this.config, message, parsed.value.signature);
    if (!verified.ok) return verified;
    const reserved = reservePaymentNonce(this.db, message.nonce, this.clock.now());
    if (!reserved.ok) return reserved;
    return {
      ok: true,
      value: {
        mode: "live",
        from: message.from,
        units: message.value,
        nonce: message.nonce,
        priceUnits,
        message,
        signature: parsed.value.signature,
      },
    };
  }

  private async commitDryPayment(seller: AgentRecord, payment: HeldPayment, nonceKey: string): Promise<Result<{ txHash?: string }>> {
    const balance = await this.chain.getBalance(payment.from);
    if (!balance.ok) return { ok: false, error: balance.error };
    if (balance.units < payment.units) return { ok: false, error: "Payer's simulated USDC balance is too low." };
    const payer = getAgentByAddress(this.db, payment.from);
    const moved = await this.chain.transferBetween(payment.from, seller.walletAddress, payment.units);
    if (!moved.ok) return { ok: false, error: moved.error ?? "Transfer failed." };
    const payerClass = this.payerClass(payment.from);
    // The ledger credit and the nonce mark commit together. No await inside this block,
    // so a second request cannot start its own transaction in the gap.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (payer) {
        const debited = this.debit(payer.id, payment.priceUnits, "x402", `x402-out:${payment.nonce}`, `paid ${seller.name}`, true);
        if (!debited.ok) throw new Error(debited.error);
        if (debited.value.duplicate) throw new Error("Payment nonce was already used.");
      }
      const credited = this.post({
        agentId: seller.id,
        kind: "x402_in",
        amount: payment.priceUnits,
        ref: `x402-in:${payment.nonce}`,
        note: `from ${payment.from}`,
        inTransaction: true,
        payerClass,
      });
      if (!credited.ok) throw new Error(credited.error);
      if (credited.value.duplicate) throw new Error("Payment nonce was already used.");
      markNonceUsed(this.db, payment.nonce, this.clock.now());
      kvSet(this.db, nonceKey, "1");
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already closed
      }
      await this.chain.transferBetween(seller.walletAddress, payment.from, payment.units);
      const message = error instanceof Error ? error.message : "Payment commit failed.";
      return { ok: false, error: message };
    }
    this.event(seller.id, "x402_in", `Paid ${formatUsd(payment.priceUnits)} by ${payment.from} (${payerClass})`, payerClass);
    return { ok: true, value: { txHash: moved.txHash } };
  }

  private async commitLivePayment(seller: AgentRecord, payment: HeldPayment, nonceKey: string): Promise<Result<{ txHash?: string }>> {
    if (!payment.message || !payment.signature) return { ok: false, error: "Payment payload is missing authorization or signature." };
    const settler = this.settler ?? new SimulatedSettler(this.chain);
    const settled = await settler.settle(payment.message, payment.signature);
    if (!settled.ok) return { ok: false, error: settled.error };
    let drift = "";
    const payerClass = this.payerClass(payment.from);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const credited = this.post({
        agentId: seller.id,
        kind: "x402_in",
        amount: payment.priceUnits,
        ref: `onchain:${settled.txHash}`,
        note: `x402 from ${payment.from}`,
        inTransaction: true,
        payerClass,
      });
      if (!credited.ok) throw new Error(credited.error);
      const payer = getAgentByAddress(this.db, payment.from);
      if (payer) {
        const debited = this.debit(payer.id, payment.priceUnits, "x402", `x402-out:${settled.txHash}`, `paid ${seller.name}`, true);
        if (!debited.ok) {
          drift = `Settlement ${settled.txHash} confirmed but the payer ledger debit failed: ${debited.error}`;
        }
      }
      markNonceUsed(this.db, payment.nonce, this.clock.now());
      kvSet(this.db, nonceKey, settled.txHash);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already closed
      }
      const message = error instanceof Error ? error.message : "Payment commit failed.";
      return { ok: false, error: message };
    }
    const payer = getAgentByAddress(this.db, payment.from);
    if (drift && payer) this.event(payer.id, "ledger_drift", drift);
    this.event(
      seller.id,
      "x402_in",
      `Settled ${formatUsd(payment.priceUnits)} in ${settled.txHash} (${payerClass}).`,
      payerClass,
    );
    return { ok: true, value: { txHash: settled.txHash } };
  }

  private async publishPage(
    agentId: string,
    call: ToolCall,
  ): Promise<{ ok: true; handled: boolean; output?: string } | { ok: false; reason: string }> {
    const agent = getAgent(this.db, agentId);
    if (!agent) return { ok: false, reason: "Unknown agent." };
    const slug = String(call.arguments?.slug ?? "").trim();
    const markdown = String(call.arguments?.markdown ?? "");
    if (!isPublicSlug(slug)) {
      this.event(agentId, "publish_page", `outcome=refused slug=${slug.slice(0, 40)} cost=0`);
      return { ok: false, reason: "slug must be 1-40 characters of lowercase letters, numbers, or dashes." };
    }
    if (Buffer.byteLength(markdown, "utf8") > MAX_PAGE_BYTES) {
      this.event(agentId, "publish_page", `outcome=refused slug=${slug} cost=0`);
      return { ok: false, reason: "Page is larger than 200 KB." };
    }
    if (markdown.trim() === "") {
      this.event(agentId, "publish_page", `outcome=refused slug=${slug} cost=0`);
      return { ok: false, reason: "Page is empty." };
    }
    const review = reviewText(markdown);
    if (!review.allowed) return this.blocked(agentId, `Law ${review.law}: ${review.reason}`);
    if (getEndpoint(this.db, agentId, slug)) {
      this.event(agentId, "publish_page", `outcome=refused slug=${slug} cost=0`);
      return { ok: false, reason: "That name is already a paid endpoint." };
    }
    const existing = getPage(this.db, agentId, slug);
    if (!existing && countPages(this.db, agentId) >= MAX_PAGES_PER_AGENT) {
      this.event(agentId, "publish_page", `outcome=refused slug=${slug} cost=0`);
      return { ok: false, reason: `Page cap is ${MAX_PAGES_PER_AGENT}.` };
    }
    const cost = this.config.publishPagePriceUnits;
    if (cost > 0) {
      const charged = this.debit(agentId, cost, "tool", `tool:${call.id}`, "publish_page");
      if (!charged.ok) return { ok: false, reason: charged.error };
      if (charged.value.duplicate) return { ok: false, reason: "publish_page call was already billed." };
    }
    try {
      this.db
        .prepare(
          `INSERT INTO pages (agent_id, slug, markdown, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(agent_id, slug) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at`,
        )
        .run(agentId, slug, markdown, this.clock.now());
    } catch (error) {
      this.refundTool(agentId, cost, `refund:publish:${call.id}`, "publish_page refund");
      const reason = error instanceof Error ? error.message : "Could not save the page.";
      return { ok: false, reason };
    }
    const bytes = Buffer.byteLength(markdown, "utf8");
    this.event(agentId, "publish_page", `outcome=ok slug=${slug} bytes=${bytes} cost=${cost}`);
    return { ok: true, handled: true, output: `Published /a/${agentId}/${slug} (${bytes} bytes).` };
  }

  private async serveEndpoint(
    agentId: string,
    call: ToolCall,
  ): Promise<{ ok: true; handled: boolean; output?: string } | { ok: false; reason: string }> {
    const agent = getAgent(this.db, agentId);
    if (!agent) return { ok: false, reason: "Unknown agent." };
    const name = String(call.arguments?.name ?? "").trim();
    const handlerDir = String(call.arguments?.handler_dir ?? call.arguments?.handlerDir ?? "").trim();
    if (!isPublicSlug(name)) {
      this.event(agentId, "serve_endpoint", `outcome=refused endpoint=${name.slice(0, 40)} cost=0`);
      return { ok: false, reason: "name must be 1-40 characters of lowercase letters, numbers, or dashes." };
    }
    if (!isPublicSlug(handlerDir)) {
      this.event(agentId, "serve_endpoint", `outcome=refused endpoint=${name} cost=0`);
      return { ok: false, reason: "handler_dir must be one directory name of 1-40 lowercase letters, numbers, or dashes." };
    }
    let price = 0;
    try {
      price = (await import("./money.js")).parseUsd(String(call.arguments?.price_usd ?? call.arguments?.priceUsd ?? ""));
    } catch (error) {
      this.event(agentId, "serve_endpoint", `outcome=refused endpoint=${name} cost=0`);
      return { ok: false, reason: error instanceof Error ? error.message : "Bad price." };
    }
    if (price < this.config.serveMinPriceUnits || price > this.config.serveMaxPriceUnits) {
      this.event(agentId, "serve_endpoint", `outcome=refused endpoint=${name} price=${price} cost=0`);
      return {
        ok: false,
        reason: `price_usd must be from ${formatUsd(this.config.serveMinPriceUnits)} to ${formatUsd(this.config.serveMaxPriceUnits)}.`,
      };
    }
    if (getPage(this.db, agentId, name)) {
      this.event(agentId, "serve_endpoint", `outcome=refused endpoint=${name} cost=0`);
      return { ok: false, reason: "That name is already a published page." };
    }
    const existing = getEndpoint(this.db, agentId, name);
    if (!existing && countEndpoints(this.db, agentId) >= MAX_ENDPOINTS_PER_AGENT) {
      this.event(agentId, "serve_endpoint", `outcome=refused endpoint=${name} cost=0`);
      return { ok: false, reason: `Endpoint cap is ${MAX_ENDPOINTS_PER_AGENT}.` };
    }
    const snap = snapshotHandlerDir({
      workspace: agent.workspace,
      handlerDir,
      storeRoot: handlerSnapshotRoot(this.config.dataDir),
    });
    if (!snap.ok) {
      this.event(agentId, "serve_endpoint", `outcome=refused endpoint=${name} cost=0`);
      return { ok: false, reason: snap.error };
    }
    const cost = this.config.serveEndpointPriceUnits;
    if (cost > 0) {
      const charged = this.debit(agentId, cost, "tool", `tool:${call.id}`, "serve_endpoint");
      if (!charged.ok) return { ok: false, reason: charged.error };
      if (charged.value.duplicate) return { ok: false, reason: "serve_endpoint call was already billed." };
    }
    try {
      this.db
        .prepare(
          `INSERT INTO endpoints (agent_id, name, price_units, snapshot_hash, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(agent_id, name) DO UPDATE SET price_units = excluded.price_units, snapshot_hash = excluded.snapshot_hash, updated_at = excluded.updated_at`,
        )
        .run(agentId, name, price, snap.hash, this.clock.now());
    } catch (error) {
      this.refundTool(agentId, cost, `refund:serve:${call.id}`, "serve_endpoint refund");
      const reason = error instanceof Error ? error.message : "Could not register the endpoint.";
      return { ok: false, reason };
    }
    this.event(agentId, "serve_endpoint", `outcome=ok endpoint=${name} price=${price} snapshot=${snap.hash} cost=${cost}`);
    return {
      ok: true,
      handled: true,
      output: `Registered /a/${agentId}/${name} at ${formatUsd(price)}. Snapshot ${snap.hash.slice(0, 12)}.`,
    };
  }

  private refundTool(agentId: string, units: number, ref: string, note: string): void {
    if (units <= 0) return;
    const posted = this.post({ agentId, kind: "tool", amount: units, ref, note });
    if (!posted.ok || posted.value.duplicate) return;
    this.db
      .prepare("INSERT INTO spend (agent_id, amount_units, category, day, created_at) VALUES (?, ?, 'tool', ?, ?)")
      .run(agentId, -units, dayKey(this.clock.now()), this.clock.now());
  }

  async syncChain(): Promise<void> {
    for (const agent of this.living()) {
      const cursor = agent.lastLogBlock ? BigInt(agent.lastLogBlock) : null;
      const synced = await this.chain.sync(agent.walletAddress, cursor);
      if (!synced.ok) {
        this.event(agent.id, "chain_unreachable", synced.error);
        continue;
      }
      for (const transfer of synced.transfers) {
        if (!Number.isSafeInteger(Number(transfer.units))) continue;
        this.creditIncome(agent.id, Number(transfer.units), transfer.txHash, transfer.from);
      }
      this.db.prepare("UPDATE agents SET last_log_block = ? WHERE id = ?").run(synced.toBlock.toString(), agent.id);
    }
  }

  async observeBalance(agentId: string): Promise<Result<{ units: bigint }>> {
    const agent = getAgent(this.db, agentId);
    if (!agent) return { ok: false, error: "Unknown agent." };
    const before = agent.balanceUnits;
    const status = agent.status;
    const read = await this.chain.getBalance(agent.walletAddress);
    const after = getAgent(this.db, agentId);
    if (!after || after.balanceUnits !== before || after.status !== status) {
      return { ok: false, error: "Chain observation changed the ledger. That is a bug." };
    }
    if (!read.ok) {
      this.event(agentId, "chain_unreachable", read.error);
      return { ok: false, error: read.error };
    }
    return { ok: true, value: { units: read.units } };
  }

  service(agentId: string) {
    return getService(this.db, agentId);
  }

  overview() {
    const agents = listAgents(this.db).map((agent) => {
      const tier = tierFor(agent.balanceUnits, this.config);
      const turns = this.db
        .prepare("SELECT content, created_at FROM turns WHERE agent_id = ? ORDER BY id DESC LIMIT 8")
        .all(agent.id) as unknown as { content: string; created_at: number }[];
      const children = listAgents(this.db)
        .filter((child) => child.parentId === agent.id)
        .map((child) => ({ id: child.id, name: child.name, status: child.status }));
      const outsideUnits = this.outsideIncome(agent.id);
      const siblingUnits = this.siblingIncome(agent.id);
      const netUnits = this.profit(agent.id);
      return {
        id: agent.id,
        name: agent.name,
        status: agent.status,
        tier,
        model: modelFor(agent, tier, this.config),
        balanceUnits: agent.balanceUnits,
        balance: formatUsd(agent.balanceUnits),
        incomeUnits: netUnits,
        income: formatUsd(netUnits),
        outsideIncomeUnits: outsideUnits,
        outsideIncome: formatUsd(outsideUnits),
        siblingIncomeUnits: siblingUnits,
        siblingIncome: formatUsd(siblingUnits),
        netOfCostUnits: netUnits,
        netOfCost: formatUsd(netUnits),
        subsidyUnits: this.sumKinds(agent.id, ["owner_topup", "replication_in"]),
        subsidy: formatUsd(this.sumKinds(agent.id, ["owner_topup", "replication_in"])),
        spendUnits: this.spendTotal(agent.id),
        spend: formatUsd(this.spendTotal(agent.id)),
        rentChargedUnits: -this.sumKinds(agent.id, ["rent"]),
        rentCharged: formatUsd(-this.sumKinds(agent.id, ["rent"])),
        rentDue: formatUsd(this.config.dailyRentUnits),
        nextRentAt: this.lastRentAt + this.config.rentIntervalMs,
        graceUntil: agent.graceUntil,
        walletAddress: agent.walletAddress,
        parentId: agent.parentId,
        depth: agent.depth,
        containerId: agent.containerId,
        lastAction: agent.lastAction,
        lastActions: turns
          .map((turn) => ({ at: turn.created_at, text: turn.content }))
          .reverse(),
        children,
      };
    });
    const events = this.db
      .prepare("SELECT agent_id, kind, message, created_at FROM events ORDER BY id DESC LIMIT 60")
      .all() as unknown as { agent_id: string | null; kind: string; message: string; created_at: number }[];
    return {
      killSwitch: this.killed,
      moneyMode: this.config.moneyMode,
      network: this.config.network,
      allowMainnet: this.config.allowMainnet,
      population: this.population(),
      maxPopulation: this.config.maxPopulation,
      maxDepth: this.config.maxDepth,
      globalSpendUnits: this.spentToday(null),
      globalSpend: formatUsd(this.spentToday(null)),
      globalCapUnits: this.config.globalDailyCapUnits,
      globalCap: formatUsd(this.config.globalDailyCapUnits),
      agentCap: formatUsd(this.config.agentDailyCapUnits),
      rentUnits: this.config.dailyRentUnits,
      rent: formatUsd(this.config.dailyRentUnits),
      rentIntervalMs: this.config.rentIntervalMs,
      graceMs: this.config.graceMs,
      clockNow: this.clock.now(),
      nextRentAt: this.lastRentAt + this.config.rentIntervalMs,
      treasury: this.config.treasury,
      treasurySwept: kvGet(this.db, "treasury_swept_units") ?? "0",
      llmMode: this.config.llmMode,
      runtime: this.config.runtime,
      dailyReport: kvGet(this.db, "daily_report") ?? "",
      agents,
      events: events.map((event) => ({
        agentId: event.agent_id,
        kind: event.kind,
        message: event.message,
        at: event.created_at,
      })),
    };
  }

  async setKillSwitch(on: boolean): Promise<void> {
    this.killed = on;
    kvSet(this.db, "kill_switch", on ? "1" : "0");
    this.event(null, on ? "kill_switch_on" : "kill_switch_off", on ? "Kill switch engaged." : "Kill switch released.");
    if (on) {
      for (const agent of this.living()) await this.runtime.stop(agent.id);
      return;
    }
    for (const agent of this.living()) {
      const token = newToken();
      this.tokens.set(agent.id, token);
      this.db.prepare("UPDATE agents SET token_hash = ? WHERE id = ?").run(sha256(token), agent.id);
      const handle = await this.runtime.start({ id: agent.id, token, workspace: agent.workspace });
      this.db.prepare("UPDATE agents SET container_id = ? WHERE id = ?").run(handle.containerId, agent.id);
    }
  }

  async resumeLiving(): Promise<void> {
    if (this.killed) return;
    for (const agent of this.living()) {
      const token = newToken();
      this.tokens.set(agent.id, token);
      this.db.prepare("UPDATE agents SET token_hash = ? WHERE id = ?").run(sha256(token), agent.id);
      try {
        const handle = await this.runtime.start({ id: agent.id, token, workspace: agent.workspace });
        this.db.prepare("UPDATE agents SET container_id = ? WHERE id = ?").run(handle.containerId, agent.id);
      } catch (error) {
        this.event(agent.id, "start_failed", error instanceof Error ? error.message : "resume failed");
      }
    }
  }

  private async payRequest(agentId: string, url: string, maxUsd: string): Promise<Result<string>> {
    const review = await reviewUrl(url, this.config.denyHosts, this.resolveHost);
    if (!review.allowed) return { ok: false, error: review.reason };
    let maxUnits = 0;
    try {
      maxUnits = (await import("./money.js")).parseUsd(maxUsd);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Bad max." };
    }
    const local = url.match(/\/a\/(a[a-f0-9]+)\/?$/);
    if (!local) {
      if (this.config.moneyMode !== "live") {
        return { ok: false, error: "Dry-run can pay another local agent at /a/<id>. External x402 needs MONEY_MODE=live." };
      }
      return this.payExternal(agentId, url, maxUnits);
    }
    const sellerId = local[1];
    const service = getService(this.db, sellerId);
    if (!service) return { ok: false, error: "That agent has no offer." };
    if (service.priceUnits > maxUnits) return { ok: false, error: "Price is above the maximum you allowed." };
    const nonce = newId("pay");
    const buyer = getAgent(this.db, agentId);
    if (!buyer) return { ok: false, error: "Unknown buyer." };
    const header = `dryrun:${buyer.walletAddress}:${service.priceUnits}:${nonce}`;
    const settled = await this.settleDryPayment(sellerId, header);
    if (!settled.ok) return settled;
    return { ok: true, value: settled.value.body.slice(0, 2000) };
  }

  startReports(): void {
    void this.writeDailyReport();
    if (this.config.reportIntervalMs <= 0 || this.reportTimer) return;
    this.reportTimer = setInterval(() => {
      void this.writeDailyReport();
    }, this.config.reportIntervalMs);
    this.reportTimer.unref?.();
  }

  writeDailyReport(): { path: string; markdown: string } {
    const now = this.clock.now();
    const day = dayKey(now);
    const since = now - 86_400_000;
    const agents = listAgents(this.db);
    const alive = agents.filter((agent) => agent.status !== "archived");
    const dead = agents.filter((agent) => agent.status === "archived");
    const events = this.db
      .prepare("SELECT agent_id, kind, message, created_at FROM events WHERE created_at >= ? ORDER BY id ASC")
      .all(since) as unknown as { agent_id: string | null; kind: string; message: string; created_at: number }[];
    const limits = rateLimitCounts();
    const notable = events.filter((event) =>
      ["died", "income", "x402_in", "spawn", "constitution_block", "swept", "grace", "recovered"].includes(event.kind),
    );
    const lines = [
      `# Automaton daily report ${day}`,
      "",
      `Clock: ${new Date(now).toISOString()}`,
      `Network: ${this.config.network} (${this.config.moneyMode})`,
      `Model: ${this.config.defaultModel}`,
      `Alive: ${alive.length}`,
      `Dead: ${dead.length}`,
      `HTTP 429: facilitator ${limits.facilitator}, openrouter ${limits.openrouter}, search ${limits.search}`,
      "Untagged inbound ledger rows have no payer class. They count as outside income.",
      "",
      "## Agents",
    ];
    for (const agent of agents) {
      lines.push(
        `### ${agent.name}`,
        `- status: ${agent.status}`,
        `- tier: ${tierFor(agent.balanceUnits, this.config)}`,
        `- balance: ${formatUsd(agent.balanceUnits)}`,
        `- outside income: ${formatUsd(this.outsideIncome(agent.id))}`,
        `- sibling income: ${formatUsd(this.siblingIncome(agent.id))}`,
        `- net of cost: ${formatUsd(this.profit(agent.id))}`,
        `- spend: ${formatUsd(this.spendTotal(agent.id))}`,
        `- last: ${agent.lastAction ?? "(none)"}`,
        "",
      );
    }
    lines.push("## Notable actions");
    if (notable.length === 0) lines.push("- None in the last day.");
    for (const event of notable.slice(-40)) {
      lines.push(`- ${new Date(event.created_at).toISOString()} ${event.kind}: ${event.message}`);
    }
    lines.push("");
    const markdown = lines.join("\n");
    const dir = path.join(this.config.dataDir, "reports");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${day}.md`);
    fs.writeFileSync(file, markdown);
    kvSet(this.db, "daily_report", markdown);
    return { path: file, markdown };
  }

  private async payExternal(agentId: string, url: string, maxUnits: number): Promise<Result<string>> {
    const buyer = getAgent(this.db, agentId);
    if (!buyer) return { ok: false, error: "Unknown buyer." };
    let response: Response;
    try {
      response = await fetch(url, { redirect: "manual" });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Payment request failed." };
    }
    if (response.status !== 402) {
      const text = await response.text();
      return { ok: true, value: `HTTP ${response.status}\n${text.slice(0, 2000)}` };
    }
    const challenge = await readPaymentRequired(response);
    const accept = challenge.accepts?.[0];
    if (!accept?.payTo || !accept.amount) return { ok: false, error: "402 response did not include an exact payment requirement." };
    let price: bigint;
    try {
      price = BigInt(accept.amount);
    } catch {
      return { ok: false, error: "402 amount is not an integer." };
    }
    if (price > BigInt(maxUnits)) return { ok: false, error: "Price is above the maximum you allowed." };
    if (!Number.isSafeInteger(Number(price))) return { ok: false, error: "Price is too large for the ledger." };
    const allowed = this.authorize(agentId, Number(price), "x402");
    if (!allowed.ok) return allowed;
    const { signAuthorization, encodePaymentHeader, v2PaymentHeaders } = await import("./x402.js");
    const key = decryptWalletKey(buyer.walletCiphertext, this.config.masterKey);
    const nonce = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
    const now = BigInt(Math.floor(this.clock.now() / 1000));
    const { privateKeyToAccount } = await import("viem/accounts");
    const message = {
      from: privateKeyToAccount(key).address,
      to: accept.payTo as `0x${string}`,
      value: price,
      validAfter: 0n,
      validBefore: now + 300n,
      nonce,
    };
    const signature = await signAuthorization(key, this.config, message);
    const header = encodePaymentHeader({
      config: this.config,
      message,
      signature,
      resource: url,
      description: accept.description ?? "paid request",
    });
    const paid = await fetch(url, { redirect: "manual", headers: v2PaymentHeaders(header) });
    const body = (await paid.text()).slice(0, 4000);
    if (!paid.ok) return { ok: false, error: `Paid request failed with HTTP ${paid.status}. Ledger was not debited. ${body.slice(0, 300)}` };
    const debited = this.debit(agentId, Number(price), "x402", `x402-out:${nonce}`, `external ${url}`);
    if (!debited.ok) return { ok: false, error: `The remote server accepted payment but the ledger debit failed: ${debited.error}` };
    return { ok: true, value: body };
  }

  private async seePage(
    agentId: string,
    call: ToolCall,
  ): Promise<{ ok: true; handled: boolean; output?: string } | { ok: false; reason: string }> {
    const agent = getAgent(this.db, agentId);
    if (!agent) return { ok: false, reason: "Unknown agent." };
    const url = String(call.arguments?.url ?? "").trim();
    const screenshot = call.arguments?.screenshot === true || call.arguments?.screenshot === "true";
    const review = await reviewUrl(url, this.config.denyHosts, this.resolveHost);
    if (!review.allowed) {
      this.noteSee(agentId, url, 0, "refused");
      return this.blocked(agentId, review.reason);
    }
    if (this.seePageUses(agentId) >= this.config.seePageHourlyLimit) {
      const reason = `see_page hourly limit is ${this.config.seePageHourlyLimit}.`;
      this.noteSee(agentId, url, 0, "limit");
      return { ok: false, reason };
    }
    const cost = this.config.seePagePriceUnits + (screenshot ? this.config.seePageScreenshotPriceUnits : 0);
    const debited = this.debit(agentId, cost, "tool", `tool:${call.id}`, "see_page");
    if (!debited.ok) return { ok: false, reason: debited.error };
    if (debited.value.duplicate) return { ok: false, reason: "see_page call was already billed." };
    const denyHosts = [...new Set([...constitutionDenyHosts(), ...this.config.denyHosts])];
    try {
      const page = await this.sensesClient.see({ url, screenshot, denyHosts });
      let evidence = "";
      if (screenshot) {
        const saved = this.saveScreenshot(agent.workspace, page.png);
        if (!saved.ok) {
          this.refundSee(agentId, cost, call.id);
          this.noteSee(agentId, url, 0, "error");
          return { ok: false, reason: saved.error };
        }
        evidence = saved.path;
      }
      this.noteSee(agentId, url, cost, "ok", evidence);
      const text = [page.title, page.markdown, page.links.join("\n"), evidence ? `Saved screenshot to ${evidence}.` : ""]
        .filter((part) => part && part.trim())
        .join("\n\n");
      return { ok: true, handled: true, output: text.slice(0, 8000) };
    } catch (error) {
      this.refundSee(agentId, cost, call.id);
      this.noteSee(agentId, url, 0, "error");
      const reason = error instanceof Error ? error.message : "see_page failed.";
      return { ok: false, reason: reason.slice(0, 300) };
    }
  }

  private seePageUses(agentId: string): number {
    const since = this.clock.now() - 3_600_000;
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM ledger_entries WHERE agent_id = ? AND note = 'see_page' AND amount_units < 0 AND created_at > ?",
      )
      .get(agentId, since) as { n: number };
    return row.n;
  }

  private refundSee(agentId: string, units: number, callId: string): void {
    const posted = this.post({
      agentId,
      kind: "tool",
      amount: units,
      ref: `refund:${callId}`,
      note: "see_page refund",
    });
    if (!posted.ok || posted.value.duplicate) return;
    this.db
      .prepare("INSERT INTO spend (agent_id, amount_units, category, day, created_at) VALUES (?, ?, 'tool', ?, ?)")
      .run(agentId, -units, dayKey(this.clock.now()), this.clock.now());
  }

  private saveScreenshot(
    workspace: string,
    png: string | undefined,
  ): { ok: true; path: string } | { ok: false; error: string } {
    if (!png) return { ok: false, error: "Senses did not return a screenshot." };
    const bytes = Buffer.from(png, "base64");
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes.toString("ascii", 1, 4) !== "PNG") {
      return { ok: false, error: "Screenshot was not a PNG." };
    }
    const name = `${this.clock.now()}-${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}.png`;
    const relative = `evidence/${name}`;
    const dest = path.join(workspace, "evidence", name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    return { ok: true, path: relative };
  }

  private noteSee(agentId: string, url: string, cost: number, outcome: string, evidence = ""): void {
    const extra = evidence ? ` evidence=${evidence}` : "";
    this.event(agentId, "see_page", `outcome=${outcome} cost=${cost} url=${url}${extra}`);
  }

  private async crawlSite(
    agentId: string,
    call: ToolCall,
  ): Promise<{ ok: true; handled: boolean; output?: string } | { ok: false; reason: string }> {
    const agent = getAgent(this.db, agentId);
    if (!agent) return { ok: false, reason: "Unknown agent." };
    const url = String(call.arguments?.url ?? "").trim();
    const maxPages = this.readCrawlPages(call.arguments?.max_pages);
    const sameDomain = call.arguments?.same_domain !== false && call.arguments?.same_domain !== "false";
    const review = await reviewUrl(url, this.config.denyHosts, this.resolveHost);
    if (!review.allowed) {
      this.noteCrawl(agentId, url, 0, 0, 0, "refused");
      return this.blocked(agentId, review.reason);
    }
    if (this.crawlUses(agentId) >= this.config.crawlHourlyLimit) {
      const reason = `crawl_site hourly limit is ${this.config.crawlHourlyLimit}.`;
      this.noteCrawl(agentId, url, 0, 0, 0, "limit");
      return { ok: false, reason };
    }
    const price = this.config.crawlPagePriceUnits;
    const hold = maxPages * price;
    const reserved = this.authorize(agentId, hold, "tool");
    if (!reserved.ok) {
      this.noteCrawl(agentId, url, 0, 0, 0, "unaffordable");
      return { ok: false, reason: reserved.error };
    }
    const debited = this.debit(agentId, hold, "tool", `tool:${call.id}`, "crawl_site");
    if (!debited.ok) {
      this.noteCrawl(agentId, url, 0, 0, 0, "unaffordable");
      return { ok: false, reason: debited.error };
    }
    if (debited.value.duplicate) return { ok: false, reason: "crawl_site call was already billed." };
    const denyHosts = [...new Set([...constitutionDenyHosts(), ...this.config.denyHosts])];
    try {
      const crawl = await this.sensesClient.crawl({ url, maxPages, sameDomain, denyHosts });
      const fetched = Math.min(crawl.pages.length, maxPages);
      const refundUnits = hold - fetched * price;
      if (refundUnits > 0) this.refundCrawl(agentId, refundUnits, call.id);
      const cost = fetched * price;
      const saved = this.saveCrawl(agent.workspace, crawl);
      if (!saved.ok) {
        if (cost > 0) this.refundCrawl(agentId, cost, `${call.id}:save`);
        this.noteCrawl(agentId, url, 0, crawl.skipped.length, 0, "error");
        return { ok: false, reason: saved.error };
      }
      this.noteCrawl(agentId, url, fetched, crawl.skipped.length, cost, "ok", saved.path);
      return { ok: true, handled: true, output: presentCrawl(crawl, saved.path) };
    } catch (error) {
      this.refundCrawl(agentId, hold, call.id);
      this.noteCrawl(agentId, url, 0, 0, 0, "error");
      const reason = error instanceof Error ? error.message : "crawl_site failed.";
      return { ok: false, reason: reason.slice(0, 300) };
    }
  }

  private readCrawlPages(value: unknown): number {
    const configured = Number.isFinite(this.config.crawlMaxPages) ? Math.floor(this.config.crawlMaxPages) : 20;
    const cap = Math.min(Math.max(configured, 1), 20);
    const fallback = Math.min(10, cap);
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    if (!Number.isFinite(parsed)) return fallback;
    const whole = Math.floor(parsed);
    if (whole < 1) return fallback;
    return Math.min(whole, cap);
  }

  private crawlUses(agentId: string): number {
    const since = this.clock.now() - 3_600_000;
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM ledger_entries WHERE agent_id = ? AND note = 'crawl_site' AND amount_units < 0 AND created_at > ?",
      )
      .get(agentId, since) as { n: number };
    return row.n;
  }

  private refundCrawl(agentId: string, units: number, callId: string): void {
    if (units <= 0) return;
    const posted = this.post({
      agentId,
      kind: "tool",
      amount: units,
      ref: `refund:${callId}`,
      note: "crawl_site refund",
    });
    if (!posted.ok || posted.value.duplicate) return;
    this.db
      .prepare("INSERT INTO spend (agent_id, amount_units, category, day, created_at) VALUES (?, ?, 'tool', ?, ?)")
      .run(agentId, -units, dayKey(this.clock.now()), this.clock.now());
  }

  private saveCrawl(
    workspace: string,
    crawl: CrawlSiteResult,
  ): { ok: true; path: string } | { ok: false; error: string } {
    const payload = JSON.stringify(crawl, null, 2);
    const name = `${this.clock.now()}-${createHash("sha256").update(payload).digest("hex").slice(0, 8)}-crawl.json`;
    const relative = `evidence/${name}`;
    const dest = path.join(workspace, "evidence", name);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save the crawl.";
      return { ok: false, error: message };
    }
    return { ok: true, path: relative };
  }

  private async readFeed(
    agentId: string,
    call: ToolCall,
  ): Promise<{ ok: true; handled: boolean; output?: string } | { ok: false; reason: string }> {
    const agent = getAgent(this.db, agentId);
    if (!agent) return { ok: false, reason: "Unknown agent." };
    const source = String(call.arguments?.source ?? "").trim().toLowerCase();
    const query = String(call.arguments?.query ?? "").trim();
    const options = readFeedOptions(call.arguments?.options);
    if (!(FEED_SOURCE_NAMES as readonly string[]).includes(source)) {
      this.noteFeed(agentId, source, query, 0, 0, "refused");
      return { ok: false, reason: "unknown source" };
    }
    if (!query || query.length > 2_000) {
      this.noteFeed(agentId, source, query, 0, 0, "refused");
      return { ok: false, reason: query ? "query is too long." : "query is required." };
    }
    if (source === "rss") {
      const review = await reviewUrl(query, this.config.denyHosts, this.resolveHost);
      if (!review.allowed) {
        this.noteFeed(agentId, source, query, 0, 0, "refused");
        return this.blocked(agentId, review.reason);
      }
    }
    if (this.feedUses(agentId) >= this.config.readFeedHourlyLimit) {
      const reason = `read_feed hourly limit is ${this.config.readFeedHourlyLimit}.`;
      this.noteFeed(agentId, source, query, 0, 0, "limit");
      return { ok: false, reason };
    }
    const cost = this.config.readFeedPriceUnits;
    const debited = this.debit(agentId, cost, "tool", `tool:${call.id}`, "read_feed");
    if (!debited.ok) return { ok: false, reason: debited.error };
    if (debited.value.duplicate) return { ok: false, reason: "read_feed call was already billed." };
    const denyHosts = [...new Set([...constitutionDenyHosts(), ...this.config.denyHosts])];
    try {
      const result = await this.sensesClient.feed({
        source,
        query,
        options,
        denyHosts,
        userAgent: this.config.redditUserAgent,
      });
      const saved = this.saveFeed(agent.workspace, result);
      // A reddit block is a completed request, so the fee stays. Senses errors refund below.
      if (result.blocked) {
        this.noteFeedBlocked(agentId, source, result.status ?? 0, result.reason ?? "blocked");
        this.noteFeed(agentId, source, query, 0, cost, "blocked", saved.ok ? saved.path : "");
        return { ok: true, handled: true, output: presentFeed(result, saved.ok ? saved.path : "") };
      }
      if (!saved.ok) {
        this.refundFeed(agentId, cost, call.id);
        this.noteFeed(agentId, source, query, 0, 0, "error");
        return { ok: false, reason: saved.error };
      }
      const outcome = result.unavailable ? "unavailable" : "ok";
      this.noteFeed(agentId, source, query, result.items.length, cost, outcome, saved.path);
      return { ok: true, handled: true, output: presentFeed(result, saved.path) };
    } catch (error) {
      this.refundFeed(agentId, cost, call.id);
      this.noteFeed(agentId, source, query, 0, 0, "error");
      const reason = error instanceof Error ? error.message : "read_feed failed.";
      return { ok: false, reason: reason.slice(0, 300) };
    }
  }

  private feedUses(agentId: string): number {
    const since = this.clock.now() - 3_600_000;
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM ledger_entries WHERE agent_id = ? AND note = 'read_feed' AND amount_units < 0 AND created_at > ?",
      )
      .get(agentId, since) as { n: number };
    return row.n;
  }

  private refundFeed(agentId: string, units: number, callId: string): void {
    if (units <= 0) return;
    const posted = this.post({
      agentId,
      kind: "tool",
      amount: units,
      ref: `refund:read_feed:${callId}`,
      note: "read_feed refund",
    });
    if (!posted.ok || posted.value.duplicate) return;
    this.db
      .prepare("INSERT INTO spend (agent_id, amount_units, category, day, created_at) VALUES (?, ?, 'tool', ?, ?)")
      .run(agentId, -units, dayKey(this.clock.now()), this.clock.now());
  }

  private saveFeed(
    workspace: string,
    result: FeedResult,
  ): { ok: true; path: string } | { ok: false; error: string } {
    const payload = JSON.stringify(result, null, 2);
    const name = `${this.clock.now()}-${createHash("sha256").update(payload).digest("hex").slice(0, 8)}-feed.json`;
    const relative = `evidence/${name}`;
    const dest = path.join(workspace, "evidence", name);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save the feed.";
      return { ok: false, error: message };
    }
    return { ok: true, path: relative };
  }

  private noteFeed(
    agentId: string,
    source: string,
    query: string,
    items: number,
    cost: number,
    outcome: string,
    evidence = "",
  ): void {
    const extra = evidence ? ` evidence=${evidence}` : "";
    const flat = query.replace(/\s+/g, " ").slice(0, 180);
    this.event(
      agentId,
      "read_feed",
      `outcome=${outcome} cost=${cost} source=${source} items=${items} query=${flat}${extra}`,
    );
  }

  private noteFeedBlocked(agentId: string, source: string, status: number, reason: string): void {
    if (source !== "reddit") return;
    this.event(agentId, "feed_blocked", `source=reddit status=${status} reason=${reason.replace(/\s+/g, " ").slice(0, 180)}`);
  }

  private noteCrawl(
    agentId: string,
    url: string,
    fetched: number,
    skipped: number,
    cost: number,
    outcome: string,
    evidence = "",
  ): void {
    const extra = evidence ? ` evidence=${evidence}` : "";
    this.event(
      agentId,
      "crawl_site",
      `outcome=${outcome} cost=${cost} fetched=${fetched} skipped=${skipped} url=${url}${extra}`,
    );
  }

  private async browseTask(
    agentId: string,
    call: ToolCall,
  ): Promise<{ ok: true; handled: boolean; output?: string } | { ok: false; reason: string }> {
    const agent = getAgent(this.db, agentId);
    if (!agent) return { ok: false, reason: "Unknown agent." };
    const task = String(call.arguments?.task ?? "").trim();
    if (!this.config.browseEnabled) {
      this.noteBrowse(agentId, task, 0, [], 0, "refused");
      return { ok: false, reason: "browse is disabled by the owner" };
    }
    if (!task || task.length > 4_000) {
      this.noteBrowse(agentId, task, 0, [], 0, "refused");
      return { ok: false, reason: task ? "task is too long." : "task is required." };
    }
    const review = reviewText(task);
    if (!review.allowed) {
      this.noteBrowse(agentId, task, 0, [], 0, "refused");
      return this.blocked(agentId, `Law ${review.law}: ${review.reason}`);
    }
    const maxSteps = this.readBrowseSteps(call.arguments?.max_steps);
    if (this.browseUses(agentId) >= this.config.browseHourlyLimit) {
      const reason = `browse hourly limit is ${this.config.browseHourlyLimit}.`;
      this.noteBrowse(agentId, task, 0, [], 0, "limit");
      return { ok: false, reason };
    }
    const preauth = maxSteps * this.config.browseStepPriceUnits + this.config.browseLlmReserveUnits;
    const reserved = this.authorize(agentId, preauth, "tool");
    if (!reserved.ok) {
      this.noteBrowse(agentId, task, 0, [], 0, "unaffordable");
      return { ok: false, reason: reserved.error };
    }
    if (!this.browseLlm) {
      this.noteBrowse(agentId, task, 0, [], 0, "refused");
      return { ok: false, reason: "browse llm proxy is not configured." };
    }
    const debited = preauth > 0 ? this.debit(agentId, preauth, "tool", `tool:${call.id}`, "browse") : { ok: true as const, value: { balance: agent.balanceUnits } };
    if (!debited.ok) {
      this.noteBrowse(agentId, task, 0, [], 0, "unaffordable");
      return { ok: false, reason: debited.error };
    }
    if (debited.value.duplicate) return { ok: false, reason: "browse call was already billed." };
    const snapshot = this.snapshot(agentId);
    const token = this.browseLlm.issue({ agentId, model: snapshot.model, now: this.clock.now() });
    const denyHosts = [...new Set([...constitutionDenyHosts(), ...this.config.denyHosts])];
    let llmCost = 0;
    try {
      const result = await this.sensesClient.browse({
        task,
        maxSteps,
        denyHosts,
        llmBaseUrl: this.config.sensesLlmBaseUrl,
        llmToken: token,
        model: snapshot.model,
      });
      llmCost = this.browseLlm.close(token);
      const steps = Math.min(maxSteps, Math.max(0, Math.floor(result.steps)));
      const stepCost = steps * this.config.browseStepPriceUnits;
      const llmCharged = Math.min(Math.max(0, llmCost), this.config.browseLlmReserveUnits);
      const actual = Math.min(preauth, stepCost + llmCharged);
      const refund = preauth - actual;
      if (refund > 0) this.refundBrowse(agentId, refund, call.id);
      const saved = this.saveBrowse(agent.workspace, { task, steps, urls: result.urls, costUnits: actual, llmCostUnits: llmCost, outcome: result.outcome, result: result.result, transcript: result.transcript });
      if (!saved.ok) {
        if (actual > 0) this.refundBrowse(agentId, actual, `${call.id}:save`);
        this.noteBrowse(agentId, task, 0, result.urls, 0, "error");
        return { ok: false, reason: saved.error };
      }
      this.noteBrowse(agentId, task, steps, result.urls, actual, result.outcome || "ok", saved.path);
      const text = [result.result, result.urls.join("\n"), `steps ${steps}`, `Saved browse to ${saved.path}.`].filter((part) => part && part.trim()).join("\n\n");
      return { ok: true, handled: true, output: text.slice(0, 8000) };
    } catch (error) {
      try {
        llmCost = this.browseLlm.close(token);
      } catch {
        llmCost = 0;
      }
      this.refundBrowse(agentId, preauth, call.id);
      this.noteBrowse(agentId, task, 0, [], 0, "error");
      const reason = error instanceof Error ? error.message : "browse failed.";
      return { ok: false, reason: reason.slice(0, 300) };
    }
  }

  private readBrowseSteps(value: unknown): number {
    const cap = Math.min(15, Math.max(1, Math.floor(this.config.browseMaxSteps) || 15));
    if (value === undefined || value === null || value === "") return cap;
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    if (!Number.isFinite(parsed)) return cap;
    const whole = Math.floor(parsed);
    if (whole < 1) return cap;
    return Math.min(whole, cap);
  }

  private browseUses(agentId: string): number {
    const since = this.clock.now() - 3_600_000;
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM ledger_entries WHERE agent_id = ? AND note = 'browse' AND amount_units < 0 AND created_at > ?",
      )
      .get(agentId, since) as { n: number };
    return row.n;
  }

  private refundBrowse(agentId: string, units: number, callId: string): void {
    if (units <= 0) return;
    const posted = this.post({
      agentId,
      kind: "tool",
      amount: units,
      ref: `refund:browse:${callId}`,
      note: "browse refund",
    });
    if (!posted.ok || posted.value.duplicate) return;
    this.db
      .prepare("INSERT INTO spend (agent_id, amount_units, category, day, created_at) VALUES (?, ?, 'tool', ?, ?)")
      .run(agentId, -units, dayKey(this.clock.now()), this.clock.now());
  }

  private saveBrowse(
    workspace: string,
    record: {
      task: string;
      steps: number;
      urls: string[];
      costUnits: number;
      llmCostUnits: number;
      outcome: string;
      result: string;
      transcript: unknown;
    },
  ): { ok: true; path: string } | { ok: false; error: string } {
    const payload = JSON.stringify(record, null, 2);
    const name = `${this.clock.now()}-${createHash("sha256").update(payload).digest("hex").slice(0, 8)}-browse.json`;
    const relative = `evidence/${name}`;
    const dest = path.join(workspace, "evidence", name);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save the browse.";
      return { ok: false, error: message };
    }
    return { ok: true, path: relative };
  }

  private noteBrowse(
    agentId: string,
    task: string,
    steps: number,
    urls: string[],
    cost: number,
    outcome: string,
    evidence = "",
  ): void {
    const extra = evidence ? ` evidence=${evidence}` : "";
    const flat = task.replace(/\s+/g, " ").slice(0, 120);
    const visited = urls.slice(0, 8).join(",");
    this.event(
      agentId,
      "browse",
      `outcome=${outcome} cost=${cost} steps=${steps} urls=${visited} task=${flat}${extra}`,
    );
  }

  private chargeTool(agentId: string, name: string, callId: string): Result<{ balance: number }> {
    const cost = this.config.toolCosts[name] ?? 0;
    if (cost === 0) return { ok: true, value: { balance: getAgent(this.db, agentId)?.balanceUnits ?? 0 } };
    return this.debit(agentId, cost, "tool", `tool:${callId}`, name);
  }

  private blocked(agentId: string, reason: string): { ok: false; reason: string } {
    this.event(agentId, "constitution_block", reason);
    return { ok: false, reason };
  }

  private chargeRent(now: number): void {
    for (const agent of this.living().filter((item) => item.status === "running")) {
      const posted = this.post({
        agentId: agent.id,
        kind: "rent",
        amount: -this.config.dailyRentUnits,
        ref: `rent:${agent.id}:${now}`,
        note: "scheduled rent",
        allowNegative: true,
      });
      if (!posted.ok) continue;
      const updated = getAgent(this.db, agent.id);
      if (updated && updated.balanceUnits <= 0 && updated.status === "running") {
        const graceUntil = now + this.config.graceMs;
        this.db
          .prepare("UPDATE agents SET status = 'grace', grace_until = ? WHERE id = ? AND status = 'running'")
          .run(graceUntil, agent.id);
        this.event(agent.id, "grace", `Rent was not covered. Grace until ${new Date(graceUntil).toISOString()}.`);
      } else {
        this.event(agent.id, "rent", `Rent ${formatUsd(this.config.dailyRentUnits)} charged. Balance ${formatUsd(posted.value.balance)}.`);
      }
    }
  }

  private async enforceDeaths(now: number): Promise<void> {
    for (const agent of listAgents(this.db)) {
      if (agent.status !== "grace") continue;
      if (agent.balanceUnits > 0) {
        this.db.prepare("UPDATE agents SET status = 'running', grace_until = NULL WHERE id = ?").run(agent.id);
        this.event(agent.id, "recovered", "Balance is positive again.");
        continue;
      }
      if (agent.graceUntil !== null && now >= agent.graceUntil) {
        await this.archive(agent.id, "Grace ended at zero. The agent was archived and its wallet swept.");
      }
    }
  }

  private async archive(agentId: string, reason: string): Promise<void> {
    const agent = getAgent(this.db, agentId);
    if (!agent || agent.status === "archived") return;
    const now = this.clock.now();
    const result = this.db
      .prepare("UPDATE agents SET status = 'archived', archived_at = ?, grace_until = NULL, last_action = ? WHERE id = ? AND status != 'archived'")
      .run(now, reason.slice(0, 300), agentId);
    if (result.changes === 0) return;
    this.tokens.delete(agentId);
    this.event(agentId, "died", reason);
    try {
      await this.runtime.stop(agentId);
    } catch (error) {
      this.event(agentId, "stop_failed", error instanceof Error ? error.message : "stop failed");
    }
    let swept = 0n;
    let txHash: string | undefined;
    try {
      const key = decryptWalletKey(agent.walletCiphertext, this.config.masterKey);
      const sweep = await this.chain.sweep(key, this.config.treasury);
      swept = sweep.units;
      txHash = sweep.txHash;
      if (!sweep.ok) this.event(agentId, "sweep_failed", sweep.error ?? "Sweep failed. USDC may still sit in the agent wallet.");
      else if (swept > 0n) {
        const previous = BigInt(kvGet(this.db, "treasury_swept_units") ?? "0");
        kvSet(this.db, "treasury_swept_units", (previous + swept).toString());
        this.event(agentId, "swept", `Swept ${swept.toString()} base units to the treasury.`);
      }
    } catch (error) {
      this.event(agentId, "sweep_failed", error instanceof Error ? error.message : "Sweep failed.");
    }
    const dest = path.join(this.config.dataDir, "archives", agentId);
    fs.mkdirSync(dest, { recursive: true });
    if (fs.existsSync(agent.workspace)) {
      fs.cpSync(agent.workspace, path.join(dest, "workspace"), { recursive: true });
    }
    fs.writeFileSync(
      path.join(dest, "manifest.json"),
      JSON.stringify(
        {
          id: agentId,
          name: agent.name,
          address: agent.walletAddress,
          finalBalanceUnits: getAgent(this.db, agentId)?.balanceUnits ?? agent.balanceUnits,
          archivedAt: now,
          reason,
          sweptUnits: swept.toString(),
          sweepTx: txHash ?? null,
          treasury: this.config.treasury,
        },
        null,
        2,
      ),
    );
  }

  private moveEndowment(parentId: string, childId: string, units: number, ref: string): Result<{ balance: number }> {
    const now = this.clock.now();
    const day = dayKey(now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const parent = getAgent(this.db, parentId);
      const child = getAgent(this.db, childId);
      if (!parent || !child) throw new Error("Missing agent.");
      if (parent.balanceUnits < units) throw new Error("Parent balance changed.");
      const parentAfter = parent.balanceUnits - units;
      this.db
        .prepare(
          "INSERT INTO ledger_entries (id, agent_id, kind, amount_units, balance_after, ref, note, created_at) VALUES (?, ?, 'replication_out', ?, ?, ?, ?, ?)",
        )
        .run(newId("led"), parentId, -units, parentAfter, ref, "child endowment", now);
      this.db.prepare("UPDATE agents SET balance_units = ? WHERE id = ?").run(parentAfter, parentId);
      this.db
        .prepare("INSERT INTO spend (agent_id, amount_units, category, day, created_at) VALUES (?, ?, 'replication', ?, ?)")
        .run(parentId, units, day, now);
      const childAfter = child.balanceUnits + units;
      this.db
        .prepare(
          "INSERT INTO ledger_entries (id, agent_id, kind, amount_units, balance_after, ref, note, created_at) VALUES (?, ?, 'replication_in', ?, ?, ?, ?, ?)",
        )
        .run(newId("led"), childId, units, childAfter, ref, "endowment from parent", now);
      this.db.prepare("UPDATE agents SET balance_units = ? WHERE id = ?").run(childAfter, childId);
      this.db.exec("COMMIT");
      return { ok: true, value: { balance: parentAfter } };
    } catch (error) {
      this.db.exec("ROLLBACK");
      return { ok: false, error: error instanceof Error ? error.message : "Endowment failed." };
    }
  }

  private post(input: PostInput): Result<{ balance: number; duplicate?: boolean }> {
    const now = this.clock.now();
    const owns = !input.inTransaction;
    if (owns) this.db.exec("BEGIN IMMEDIATE");
    const rollback = () => {
      if (owns) this.db.exec("ROLLBACK");
    };
    try {
      const agent = getAgent(this.db, input.agentId);
      if (!agent) {
        rollback();
        return { ok: false, error: "Unknown agent." };
      }
      if (agent.status === "archived") {
        rollback();
        return { ok: false, error: "Agent is archived." };
      }
      const existing = this.db
        .prepare("SELECT balance_after FROM ledger_entries WHERE agent_id = ? AND ref = ?")
        .get(input.agentId, input.ref) as { balance_after: number } | undefined;
      if (existing) {
        rollback();
        return { ok: true, value: { balance: agent.balanceUnits, duplicate: true } };
      }
      if (input.category) {
        const decision = checkSpend({
          amount: Math.abs(input.amount),
          balance: agent.balanceUnits,
          agentSpent: this.spentToday(input.agentId),
          globalSpent: this.spentToday(null),
          agentCap: this.config.agentDailyCapUnits,
          globalCap: this.config.globalDailyCapUnits,
          killSwitch: this.killed,
          allowNegative: false,
        });
        if (!decision.ok) {
          rollback();
          return { ok: false, error: decision.reason ?? "Spend refused." };
        }
      }
      const next = agent.balanceUnits + input.amount;
      if (next < 0 && !input.allowNegative) {
        rollback();
        return { ok: false, error: "Balance is too low." };
      }
      this.db
        .prepare(
          "INSERT INTO ledger_entries (id, agent_id, kind, amount_units, balance_after, ref, note, created_at, payer_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          newId("led"),
          input.agentId,
          input.kind,
          input.amount,
          next,
          input.ref,
          input.note.slice(0, 500),
          now,
          input.payerClass ?? null,
        );
      const recover = agent.status === "grace" && next > 0;
      this.db
        .prepare(
          "UPDATE agents SET balance_units = ?, status = CASE WHEN ? = 1 THEN 'running' ELSE status END, grace_until = CASE WHEN ? = 1 THEN NULL ELSE grace_until END WHERE id = ?",
        )
        .run(next, recover ? 1 : 0, recover ? 1 : 0, input.agentId);
      if (input.category) {
        this.db
          .prepare("INSERT INTO spend (agent_id, amount_units, category, day, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(input.agentId, Math.abs(input.amount), input.category, dayKey(now), now);
      }
      if (owns) this.db.exec("COMMIT");
      if (recover) this.event(input.agentId, "recovered", "Top-up cleared the grace period.");
      return { ok: true, value: { balance: next, duplicate: false } };
    } catch (error) {
      try {
        rollback();
      } catch {
        // already closed
      }
      const message = error instanceof Error ? error.message : "Ledger write failed.";
      if (message.includes("UNIQUE")) {
        return { ok: true, value: { balance: getAgent(this.db, input.agentId)?.balanceUnits ?? 0, duplicate: true } };
      }
      return { ok: false, error: message };
    }
  }

  /** Outside income minus this agent's own costs. Sibling income is excluded. Untagged rows count as outside. */
  private profit(agentId: string): number {
    const costs = this.sumKinds(agentId, ["inference", "tool", "council", "rent", "x402_out", "replication_out"]);
    return this.outsideIncome(agentId) + costs;
  }

  private outsideIncome(agentId: string): number {
    return this.sumInbound(agentId, "outside");
  }

  private siblingIncome(agentId: string): number {
    return this.sumInbound(agentId, "sibling");
  }

  private sumInbound(agentId: string, which: PayerClass): number {
    const clause = which === "sibling" ? "payer_class = 'sibling'" : "(payer_class IS NULL OR payer_class != 'sibling')";
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_units), 0) AS n FROM ledger_entries WHERE agent_id = ? AND kind IN ('onchain_income', 'x402_in') AND amount_units > 0 AND ${clause}`,
      )
      .get(agentId) as { n: number };
    return row.n;
  }

  /**
   * Treasury, the gas funder when one is configured, and every agent wallet.
   * Archived agents and this agent's own address stay in the set.
   */
  private payerClass(payer: string): PayerClass {
    const rows = this.db.prepare("SELECT wallet_address FROM agents").all() as unknown as { wallet_address: string }[];
    const addresses = [this.config.treasury, ...rows.map((row) => row.wallet_address)];
    if (this.config.gasFunderKey) addresses.push(privateKeyToAccount(this.config.gasFunderKey).address);
    return classifyPayer(payer, addresses);
  }

  private sumKinds(agentId: string, kinds: LedgerKind[]): number {
    const placeholders = kinds.map(() => "?").join(", ");
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(amount_units), 0) AS n FROM ledger_entries WHERE agent_id = ? AND kind IN (${placeholders})`)
      .get(agentId, ...kinds) as { n: number };
    return row.n;
  }

  private spendTotal(agentId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(-amount_units), 0) AS n FROM ledger_entries WHERE agent_id = ? AND amount_units < 0",
      )
      .get(agentId) as { n: number };
    return row.n;
  }

  private spentToday(agentId: string | null): number {
    const day = dayKey(this.clock.now());
    const row = agentId
      ? (this.db.prepare("SELECT COALESCE(SUM(amount_units), 0) AS n FROM spend WHERE agent_id = ? AND day = ?").get(agentId, day) as {
          n: number;
        })
      : (this.db.prepare("SELECT COALESCE(SUM(amount_units), 0) AS n FROM spend WHERE day = ?").get(day) as { n: number });
    return row.n;
  }

  private population(): number {
    return this.living().length;
  }

  private living(): AgentRecord[] {
    return listAgents(this.db).filter((agent) => agent.status === "running" || agent.status === "grace");
  }

  private event(agentId: string | null, kind: string, message: string, payerClass: PayerClass | null = null): void {
    this.db
      .prepare("INSERT INTO events (agent_id, kind, message, created_at, payer_class) VALUES (?, ?, ?, ?, ?)")
      .run(agentId, kind, message.slice(0, 500), this.clock.now(), payerClass);
  }

  private writeWorkspace(workspace: string, genesis: string, notes: string): void {
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "genesis.md"), genesis);
    fs.writeFileSync(path.join(workspace, "strategy.md"), notes);
    fs.writeFileSync(path.join(workspace, "constitution.md"), CONSTITUTION_TEXT);
  }
}

class SimulatedSettler implements PaymentSettler {
  constructor(private readonly chain: ChainPort) {}

  async settle(message: { from: string; to: string; value: bigint }): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
    const moved = await this.chain.transferBetween(message.from, message.to, message.value);
    if (!moved.ok || !moved.txHash) return { ok: false, error: moved.error ?? "Simulated settlement failed." };
    return { ok: true, txHash: moved.txHash };
  }
}

const CRAWL_PREVIEW_CHARS = 2_000;
const FEED_PREVIEW_CHARS = 500;

function readFeedOptions(value: unknown): Record<string, unknown> {
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function presentFeed(result: FeedResult, evidence: string): string {
  const saved = evidence ? `Saved feed to ${evidence}.` : "";
  if (result.blocked) {
    return [`blocked=true source=${result.source} status=${result.status ?? ""}`, result.reason ?? "", saved]
      .filter((part) => part.trim())
      .join("\n");
  }
  if (result.unavailable) {
    return [`unavailable: requires auth`, `source=${result.source}`, saved].filter((part) => part.trim()).join("\n");
  }
  const parts = [`source=${result.source} items=${result.items.length}`, saved].filter((part) => part.trim());
  for (const item of result.items) {
    const text = item.text.length > FEED_PREVIEW_CHARS ? item.text.slice(0, FEED_PREVIEW_CHARS) : item.text;
    const meta = [
      item.author ? `author=${item.author}` : "",
      item.score !== undefined ? `score=${item.score}` : "",
      item.created_at ?? "",
    ].filter(Boolean);
    parts.push([item.title, item.url, text, meta.join(" ")].filter((part) => part && part.trim()).join("\n"));
  }
  return parts.join("\n\n").slice(0, 8000);
}

function presentCrawl(crawl: CrawlSiteResult, evidence: string): string {
  const parts = [
    `robots=${crawl.robots} fetched=${crawl.pages.length} skipped=${crawl.skipped.length}`,
    `Saved crawl to ${evidence}.`,
  ];
  for (const page of crawl.pages) {
    const body = page.markdown.length > CRAWL_PREVIEW_CHARS ? page.markdown.slice(0, CRAWL_PREVIEW_CHARS) : page.markdown;
    parts.push([page.title, page.url, body].filter((part) => part && part.trim()).join("\n"));
  }
  if (crawl.skipped.length > 0) {
    parts.push(`Skipped:\n${crawl.skipped.map((item) => `${item.url} ${item.reason}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function defaultResolve(host: string): Promise<string[]> {
  if (isPrivateLiteral(host)) return [host];
  const dns = await import("node:dns/promises");
  const looked = await dns.lookup(host, { all: true });
  return looked.map((entry) => entry.address);
}

async function readPaymentRequired(response: Response): Promise<{ accepts?: { amount?: string; payTo?: string; description?: string }[] }> {
  const encoded = response.headers.get("payment-required");
  if (encoded) {
    try {
      return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { accepts?: { amount?: string; payTo?: string; description?: string }[] };
    } catch {
      return {};
    }
  }
  try {
    return (await response.json()) as { accepts?: { amount?: string; payTo?: string; description?: string }[] };
  } catch {
    return {};
  }
}

function isPrivateLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}
