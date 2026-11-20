import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DryRunChain } from "./chain.js";
import { ManualClock } from "./clock.js";
import { loadConfig, type AppConfig } from "./config.js";
import { getAgent, openDatabase } from "./db.js";
import { formatUsd, parseUsd } from "./money.js";
import { FakeRuntime } from "./runtime.js";
import { MockSearch } from "./search.js";
import {
  HttpSensesClient,
  type BrowseTaskRequest,
  type BrowseTaskResult,
  type CrawlSiteRequest,
  type CrawlSiteResult,
  type FeedRequest,
  type FeedResult,
  type SeePageRequest,
  type SeePageResult,
  type SensesClient,
} from "./senses-client.js";
import { Swarm } from "./swarm.js";
import type { ToolCall } from "./types.js";

/** Public literal. reviewUrl returns it without a DNS lookup. */
const PAGE = "http://93.184.216.34/stage";
const OPENING_USD = "0.05";

const TOOLS = ["see_page", "crawl_site", "read_feed", "publish_page", "serve_endpoint", "browse", "offer_service"] as const;

type DemoTool = (typeof TOOLS)[number];

export interface StageDemoRow {
  tool: DemoTool;
  priceUnits: number;
  balanceBefore: number;
  balanceAfter: number;
  eventId: number | null;
  ledgerId: string | null;
  record: string;
  ok: boolean;
  detail: string;
}

export interface StageDemoReport {
  ok: boolean;
  mode: "mock" | "live";
  agentId: string;
  openingUnits: number;
  closingUnits: number;
  network: string;
  allowMainnet: boolean;
  llmMode: string;
  browseEnabled: boolean;
  rows: StageDemoRow[];
  problems: string[];
  sensesCalls: string[];
  /** Temporary data directory. Removed before the function returns. */
  dir: string;
}

interface EventRow {
  id: number;
  kind: string;
  message: string;
}

interface LedgerRow {
  id: string;
  note: string;
  amount_units: number;
}

type ToolResult = { ok: true; handled: boolean; output?: string } | { ok: false; reason: string };

/**
 * Stub senses. No sockets. browse() throws because the demo expects the owner switch to refuse first.
 */
class StubSenses implements SensesClient {
  async see(_input: SeePageRequest): Promise<SeePageResult> {
    return {
      title: "Stub page",
      markdown: "Stubbed page text.",
      links: [],
    };
  }

  async crawl(input: CrawlSiteRequest): Promise<CrawlSiteResult> {
    return {
      pages: [{ url: input.url, title: "Stub page", markdown: "Stubbed crawl text." }],
      skipped: [],
      robots: "ok",
    };
  }

  async feed(input: FeedRequest): Promise<FeedResult> {
    return {
      source: input.source,
      items: [
        {
          source: input.source,
          id: "stub-1",
          title: "Stub item",
          url: PAGE,
          text: "Stubbed feed text.",
        },
      ],
      blocked: false,
      unavailable: false,
    };
  }

  async browse(_input: BrowseTaskRequest): Promise<BrowseTaskResult> {
    throw new Error("browse reached senses while the owner switch is off.");
  }
}

class RecordingSenses implements SensesClient {
  readonly calls: string[] = [];

  constructor(private readonly inner: SensesClient) {}

  async see(input: SeePageRequest): Promise<SeePageResult> {
    this.calls.push("see");
    return this.inner.see(input);
  }

  async crawl(input: CrawlSiteRequest): Promise<CrawlSiteResult> {
    this.calls.push("crawl");
    return this.inner.crawl(input);
  }

  async feed(input: FeedRequest): Promise<FeedResult> {
    this.calls.push("feed");
    return this.inner.feed(input);
  }

  async browse(input: BrowseTaskRequest): Promise<BrowseTaskResult> {
    this.calls.push("browse");
    return this.inner.browse(input);
  }
}

export interface StageDemoOptions {
  /** Hit SENSES_URL instead of the offline stubs. Not required for the exit check. */
  live?: boolean;
  /** Test hook. The CLI does not set this. */
  senses?: SensesClient;
}

export async function runStageDemo(options: StageDemoOptions = {}): Promise<StageDemoReport> {
  const live = options.live === true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-stage-"));
  const problems: string[] = [];
  const recorder = new RecordingSenses(options.senses ?? (live ? new HttpSensesClient(liveSensesUrl(problems)) : new StubSenses()));
  let db: ReturnType<typeof openDatabase> | null = null;
  const report: StageDemoReport = {
    ok: false,
    mode: live ? "live" : "mock",
    agentId: "",
    openingUnits: 0,
    closingUnits: 0,
    network: "",
    allowMainnet: false,
    llmMode: "",
    browseEnabled: false,
    rows: [],
    problems,
    sensesCalls: recorder.calls,
    dir,
  };

  try {
    const config = loadConfig(sealedEnv(dir, live));
    report.network = config.network;
    report.allowMainnet = config.allowMainnet;
    report.llmMode = config.llmMode;
    report.browseEnabled = config.browseEnabled;
    problems.push(...configProblems(config));
    if (problems.length > 0) return finish(report);

    db = openDatabase(path.join(dir, "automaton.sqlite"));
    const swarm = new Swarm(db, config, new ManualClock(1_700_000_000_000), new DryRunChain(db), new FakeRuntime(), new MockSearch(), undefined, recorder);
    const created = await swarm.createAgent({ name: "probe" });
    if (!created.ok) {
      problems.push(created.error);
      return finish(report);
    }
    report.agentId = created.value.id;
    const topped = swarm.ownerTopup(created.value.id, parseUsd(OPENING_USD), "stage-demo-seed");
    if (!topped.ok) {
      problems.push(topped.error);
      return finish(report);
    }
    report.openingUnits = swarm.snapshot(created.value.id).balanceUnits;
    const agent = getAgent(db, created.value.id);
    if (!agent) {
      problems.push("Agent disappeared after creation.");
      return finish(report);
    }
    writeHandler(agent.workspace);

    for (const tool of TOOLS) {
      report.rows.push(await runTool(swarm, db, created.value.id, tool));
    }
    report.closingUnits = swarm.snapshot(created.value.id).balanceUnits;
    if (recorder.calls.includes("browse")) problems.push("browse: senses was called while disabled");
    for (const row of report.rows) problems.push(...rowProblems(row));
    return finish(report);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : "Stage demo failed.");
    return finish(report);
  } finally {
    try {
      db?.close();
    } catch {
      // The report is already built. A close error should not hide it.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function formatStageDemo(report: StageDemoReport): string {
  const header = [
    "tool",
    "charged",
    "before",
    "after",
    "record",
  ];
  const body = report.rows.map((row) => [
    row.tool,
    formatUsd(row.priceUnits),
    formatUsd(row.balanceBefore),
    formatUsd(row.balanceAfter),
    row.record,
  ]);
  const widths = header.map((name, index) => Math.max(name.length, ...body.map((cells) => cells[index]?.length ?? 0)));
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => {
        if (index === cells.length - 1) return cell;
        const width = widths[index] ?? cell.length;
        const pad = " ".repeat(Math.max(0, width - cell.length));
        const numeric = index > 0;
        return numeric ? pad + cell : cell + pad;
      })
      .join("  ");
  const prelude = [
    `Stage 1 demo  mode ${report.mode}  money dry-run  network ${report.network || "unknown"}  mainnet ${report.allowMainnet ? "OPEN" : "locked"}  llm ${report.llmMode || "unknown"}  browse ${report.browseEnabled ? "on" : "off"}`,
    `agent ${report.agentId || "(none)"}  opening ${formatUsd(report.openingUnits)}  closing ${formatUsd(report.closingUnits)}`,
    "Records are events.id and ledger_entries.id. Each sense call also writes one evidence row.",
  ];
  const table = [line(header), ...body.map(line)];
  return [...prelude, "", ...table].join("\n");
}

export async function main(argv: string[], options: StageDemoOptions = {}): Promise<number> {
  const unexpected = argv.filter((arg) => arg !== "--live");
  if (unexpected.length > 0) {
    console.error("Usage: npm run demo [-- --live]");
    return 2;
  }
  const report = await runStageDemo({ ...options, live: argv.includes("--live") });
  console.log(formatStageDemo(report));
  if (!report.ok) {
    for (const problem of report.problems) console.error(problem);
    return 1;
  }
  console.log("ok");
  return 0;
}

function finish(report: StageDemoReport): StageDemoReport {
  report.ok = report.problems.length === 0 && report.rows.length === TOOLS.length;
  return report;
}

function sealedEnv(dir: string, live: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    DATA_DIR: dir,
    MONEY_MODE: "dry-run",
    NETWORK: "base-sepolia",
    WALLET_MASTER_KEY: "stage-demo-master-key",
    ADMIN_TOKEN: "stage-demo-admin",
    LLM_MODE: "mock",
    RUNTIME: "process",
    SEARCH_PROVIDER: "mock",
  };
  if (live && process.env.SENSES_URL) env.SENSES_URL = process.env.SENSES_URL;
  return env;
}

function liveSensesUrl(problems: string[]): string {
  const raw = (process.env.SENSES_URL ?? "http://127.0.0.1:7070").trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      problems.push("SENSES_URL must be http or https.");
      return "http://127.0.0.1:7070";
    }
  } catch {
    problems.push("SENSES_URL is not a URL.");
    return "http://127.0.0.1:7070";
  }
  return raw;
}

function configProblems(config: AppConfig): string[] {
  const problems: string[] = [];
  if (config.network !== "base-sepolia" || config.allowMainnet) problems.push("mainnet is not locked");
  if (config.moneyMode !== "dry-run") problems.push("money mode is not dry-run");
  if (config.llmMode !== "mock") problems.push("llm mode is not mock");
  if (config.browseEnabled) problems.push("browse is enabled");
  return problems;
}

function writeHandler(workspace: string): void {
  const dir = path.join(workspace, "job");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "handler.js"), "process.stdout.write('ok');\n");
}

async function runTool(swarm: Swarm, db: ReturnType<typeof openDatabase>, agentId: string, tool: DemoTool): Promise<StageDemoRow> {
  const balanceBefore = swarm.snapshot(agentId).balanceUnits;
  const eventFloor = maxEventId(db);
  const knownLedger = new Set(ledgerIds(db, agentId));
  let result: ToolResult;
  try {
    result = await swarm.handleTool(agentId, callFor(tool));
  } catch (error) {
    result = { ok: false, reason: error instanceof Error ? error.message : "tool threw" };
  }
  const balanceAfter = swarm.snapshot(agentId).balanceUnits;
  const events = eventsAfter(db, agentId, eventFloor);
  const ledgers = ledgersAfter(db, agentId, knownLedger);
  const event = events.find((row) => row.kind === tool);
  const ledger = ledgers.find((row) => row.amount_units < 0 && row.note === tool);
  const detail = result.ok ? (result.output ?? "") : result.reason;
  const written = recordText(event, ledger);
  const record = tool === "browse" && detail ? `${written} | ${detail}` : written;
  return {
    tool,
    priceUnits: balanceBefore - balanceAfter,
    balanceBefore,
    balanceAfter,
    eventId: event?.id ?? null,
    ledgerId: ledger?.id ?? null,
    record,
    ok: result.ok,
    detail,
  };
}

function callFor(tool: DemoTool): ToolCall {
  if (tool === "see_page") return { id: "demo-see", name: tool, arguments: { url: PAGE } };
  if (tool === "crawl_site") return { id: "demo-crawl", name: tool, arguments: { url: PAGE, max_pages: 1, same_domain: true } };
  if (tool === "read_feed") return { id: "demo-feed", name: tool, arguments: { source: "hn", query: "automaton" } };
  if (tool === "publish_page") return { id: "demo-page", name: tool, arguments: { slug: "note", markdown: "A page." } };
  if (tool === "serve_endpoint") {
    return { id: "demo-endpoint", name: tool, arguments: { name: "echo", price_usd: "0.01", handler_dir: "job" } };
  }
  if (tool === "browse") return { id: "demo-browse", name: tool, arguments: { task: "Read a public page.", max_steps: 1 } };
  return {
    id: "demo-offer",
    name: "offer_service",
    arguments: { priceUsd: "0.01", description: "Paid response", body: "ok" },
  };
}

function rowProblems(row: StageDemoRow): string[] {
  const charged = formatUsd(row.priceUnits);
  if (row.tool === "browse") {
    const problems: string[] = [];
    if (row.ok || !row.detail.includes("disabled by the owner")) problems.push("browse: expected disabled by the owner");
    if (row.priceUnits !== 0 || row.balanceAfter !== row.balanceBefore) problems.push(`browse: expected a $0 debit, charged ${charged}`);
    if (row.eventId == null) problems.push("browse: wrote no record");
    if (row.ledgerId != null) problems.push("browse: ledger was debited");
    if (!row.record.includes("outcome=refused") || !row.record.includes("cost=0")) problems.push("browse: event is not a zero-cost refusal");
    return problems;
  }
  const problems: string[] = [];
  if (!row.ok) problems.push(`${row.tool}: ${row.detail || "failed"}`);
  if (row.priceUnits <= 0 || row.balanceBefore - row.balanceAfter !== row.priceUnits) {
    problems.push(`${row.tool}: failed to debit (charged ${charged})`);
  }
  if (row.ledgerId == null) problems.push(`${row.tool}: wrote no ledger record`);
  if (row.tool !== "offer_service") {
    if (row.eventId == null) problems.push(`${row.tool}: wrote no event record`);
    if (!row.record.includes("outcome=ok")) problems.push(`${row.tool}: event is not a successful record`);
  }
  if (row.eventId == null && row.ledgerId == null) problems.push(`${row.tool}: wrote no record`);
  return problems;
}

function recordText(event: EventRow | undefined, ledger: LedgerRow | undefined): string {
  const parts: string[] = [];
  if (event) parts.push(`event ${event.id}`);
  if (ledger) parts.push(`ledger ${ledger.id}`);
  if (event) parts.push(event.message);
  else if (ledger) parts.push(`note=${ledger.note} amount=${ledger.amount_units}`);
  return parts.join(" | ");
}

function maxEventId(db: ReturnType<typeof openDatabase>): number {
  const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM events").get() as { n: number };
  return row.n;
}

function eventsAfter(db: ReturnType<typeof openDatabase>, agentId: string, floor: number): EventRow[] {
  return db
    .prepare("SELECT id, kind, message FROM events WHERE agent_id = ? AND id > ? ORDER BY id")
    .all(agentId, floor) as unknown as EventRow[];
}

function ledgerIds(db: ReturnType<typeof openDatabase>, agentId: string): string[] {
  const rows = db.prepare("SELECT id FROM ledger_entries WHERE agent_id = ?").all(agentId) as unknown as { id: string }[];
  return rows.map((row) => row.id);
}

function ledgersAfter(db: ReturnType<typeof openDatabase>, agentId: string, known: Set<string>): LedgerRow[] {
  const rows = db
    .prepare("SELECT id, note, amount_units FROM ledger_entries WHERE agent_id = ?")
    .all(agentId) as unknown as LedgerRow[];
  return rows.filter((row) => !known.has(row.id));
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    });
}
