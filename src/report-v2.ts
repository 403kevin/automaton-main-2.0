import type { DatabaseSync } from "node:sqlite";
import { dayKey, formatUsd } from "./money.js";
import { OK_DELIVERY } from "./predictions.js";
import { redact } from "./redact.js";
import { sanitizeSenseText, SENSE_TOOLS } from "./tripwires.js";

/**
 * The daily report's sections from the runtime's own tables (specs/BO-2.5-report-v2.md). Each function returns the lines of one
 * `##` section. The one section that quotes an agent ("Agent said") is labelled as unchecked, fenced and cleaned. Nothing here
 * ranks an agent or suggests what to sell or predict.
 */

export interface ReportAgent {
  id: string;
  name: string;
  tier: string;
  balanceUnits: number;
}

export interface ReportContext {
  db: DatabaseSync;
  now: number;
  since: number;
  /** Agents that are not archived. */
  agents: ReportAgent[];
  /** Every agent id to its name, archived ones included. */
  names: Map<string, string>;
  agentCapUnits: number;
  globalCapUnits: number;
}

const NONE = "- None in the last day.";
const EXCERPT_CHARS = 120;
const REASON_CHARS = 80;
const CLAIMS_SHOWN = 3;
const COVERAGE_TARGET_PERCENT = 95;
const LOST_WAKE_TARGET_PERCENT = 5;
const SENSE_LIST = [...SENSE_TOOLS];
const SENSE_MARKS = SENSE_LIST.map(() => "?").join(", ");
const COST_KINDS = ["inference", "tool", "council", "rent", "x402_out", "replication_out"];
const COST_MARKS = COST_KINDS.map(() => "?").join(", ");
const SEARCH_TOOLS = ["web_search"];
const BROWSE_TOOLS = ["browse"];
const FEED_TOOLS = ["read_feed"];
const VIEW_TOOLS = ["see_page", "crawl_site", "fetch_url"];

function count(ctx: ReportContext, sql: string, ...params: Array<string | number>): number {
  const row = ctx.db.prepare(sql).get(...params) as { n: number | null } | undefined;
  return row?.n ?? 0;
}

function sorted(agents: ReportAgent[]): ReportAgent[] {
  return [...agents].sort((a, b) => a.name.localeCompare(b.name));
}

function label(name: string): string {
  return sanitizeSenseText(name);
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((100 * part) / whole)}%` : "n/a";
}

/** An agent's words, made safe to print: markers defused, secrets redacted, one line, short. */
function said(text: string): string {
  const clean = sanitizeSenseText(text).replace(/<<<|>>>/g, "[fence-marker-removed]").replace(/\s+/g, " ").trim();
  return redact(clean).slice(0, EXCERPT_CHARS);
}

interface Observed {
  turns: number;
  billed: number;
  refused: number;
  paidSense: number;
  evidence: number;
}

function observed(ctx: ReportContext, agentId: string | null): Observed {
  const who = agentId ? "agent_id = ? AND " : "";
  const args = (...rest: Array<string | number>) => (agentId ? [agentId, ...rest] : rest);
  return {
    turns: count(ctx, `SELECT COUNT(*) AS n FROM turns WHERE ${who}created_at >= ?`, ...args(ctx.since)),
    billed: count(ctx, `SELECT COUNT(*) AS n FROM ledger_entries WHERE ${who}kind = 'tool' AND amount_units < 0 AND created_at >= ?`, ...args(ctx.since)),
    refused: count(ctx, `SELECT COUNT(*) AS n FROM refusals WHERE ${who}source = 'runtime' AND created_at >= ?`, ...args(ctx.since)),
    paidSense: count(
      ctx,
      `SELECT COUNT(*) AS n FROM ledger_entries WHERE ${who}kind = 'tool' AND amount_units < 0 AND note IN (${SENSE_MARKS}) AND created_at >= ?`,
      ...args(...SENSE_LIST, ctx.since),
    ),
    evidence: count(
      ctx,
      `SELECT COUNT(*) AS n FROM evidence WHERE ${who}tool IN (${SENSE_MARKS}) AND created_at >= ?`,
      ...args(...SENSE_LIST, ctx.since),
    ),
  };
}

/** The share of paid sense calls that left an evidence row, capped at 100%. A count comparison: no table links a debit to its row. */
function coverage(seen: Observed): { text: string; percent: number | null } {
  if (seen.paidSense === 0) return { text: "n/a (no paid sense calls)", percent: null };
  const share = Math.min(100, Math.round((100 * seen.evidence) / seen.paidSense));
  return { text: `${share}% (evidence rows ${seen.evidence}, paid sense calls ${seen.paidSense})`, percent: share };
}

function lostWakeCount(ctx: ReportContext, agentId: string | null): number {
  return agentId
    ? count(ctx, "SELECT COUNT(*) AS n FROM events WHERE kind = 'lost_wake' AND agent_id = ? AND created_at >= ?", agentId, ctx.since)
    : count(ctx, "SELECT COUNT(*) AS n FROM events WHERE kind = 'lost_wake' AND created_at >= ?", ctx.since);
}

function breachEvents(ctx: ReportContext): number {
  return count(ctx, "SELECT COUNT(*) AS n FROM events WHERE kind IN ('breach', 'ledger_drift') AND created_at >= ?", ctx.since);
}

/** The subject a static offer_service's test delivery would carry. No code writes one today, so every static offer is untested. */
const SERVICE_SUBJECT = "_service";

/**
 * Offers on sale whose latest test delivery is missing or not a pass: live endpoints (subject = the endpoint name) and static
 * services rows (subject = `_service`). The offer gate should make the endpoint part zero; a static offer has never been run.
 */
function phantomOffers(ctx: ReportContext): number {
  const live = ctx.db.prepare("SELECT agent_id, name FROM endpoints WHERE status = 'live' OR status IS NULL").all() as unknown as Array<{ agent_id: string; name: string }>;
  const services = ctx.db.prepare("SELECT agent_id, ? AS name FROM services").all(SERVICE_SUBJECT) as unknown as Array<{ agent_id: string; name: string }>;
  let phantom = 0;
  for (const offer of [...live, ...services]) {
    const latest = ctx.db
      .prepare("SELECT value FROM facts WHERE agent_id = ? AND kind = 'test_delivery' AND subject = ? ORDER BY id DESC LIMIT 1")
      .get(offer.agent_id, offer.name) as { value: string } | undefined;
    if (!latest || !OK_DELIVERY.test(latest.value)) phantom += 1;
  }
  return phantom;
}

export function runtimeObservedLines(ctx: ReportContext): string[] {
  const day = dayKey(ctx.now);
  const lines = [
    "## Runtime observed",
    "",
    "Last 24 hours. Counts come from the runtime's own tables, not from anything an agent said.",
    "",
  ];
  if (ctx.agents.length === 0) lines.push("- No agents alive.", "");
  for (const agent of sorted(ctx.agents)) {
    const seen = observed(ctx, agent.id);
    const spent = count(ctx, "SELECT COALESCE(SUM(amount_units), 0) AS n FROM spend WHERE agent_id = ? AND day = ?", agent.id, day);
    lines.push(
      `### ${label(agent.name)}`,
      `- turns: ${seen.turns}`,
      `- tool calls seen: ${seen.billed + seen.refused} (billed ${seen.billed}, refused ${seen.refused})`,
      `- evidence coverage: ${coverage(seen).text}`,
      `- spend today: ${formatUsd(spent)} of the agent cap ${formatUsd(ctx.agentCapUnits)}`,
      `- tier: ${agent.tier}`,
      `- balance: ${formatUsd(agent.balanceUnits)}`,
      "",
    );
  }
  const swarm = observed(ctx, null);
  const swarmSpent = count(ctx, "SELECT COALESCE(SUM(amount_units), 0) AS n FROM spend WHERE day = ?", day);
  const lost = lostWakeCount(ctx, null);
  const cover = coverage(swarm);
  const lostRate = swarm.turns > 0 ? Math.round((100 * lost) / swarm.turns) : null;
  const breaches = breachEvents(ctx);
  const phantom = phantomOffers(ctx);
  const verdict = (pass: boolean | null) => (pass === null ? "n/a" : pass ? "pass" : "fail");
  lines.push(
    "### Swarm",
    `- spend today: ${formatUsd(swarmSpent)} of the global cap ${formatUsd(ctx.globalCapUnits)}`,
    "",
    "### Stage 3 exit numbers (swarm, last 24 hours)",
    `- evidence coverage (target at least ${COVERAGE_TARGET_PERCENT}%): ${cover.percent === null ? "n/a" : `${cover.percent}%`}: ${verdict(cover.percent === null ? null : cover.percent >= COVERAGE_TARGET_PERCENT)}`,
    `- lost wakes (target under ${LOST_WAKE_TARGET_PERCENT}% of turns): ${lostRate === null ? "n/a" : `${lostRate}%`}: ${verdict(lostRate === null ? null : lostRate < LOST_WAKE_TARGET_PERCENT)}`,
    `- breaches (target 0): ${breaches}: ${verdict(breaches === 0)}`,
    `- phantom offers published (target 0): ${phantom}: ${verdict(phantom === 0)}`,
    "",
  );
  return lines;
}

export function agentSaidLines(ctx: ReportContext): string[] {
  const lines = ["## Agent said", "", "What the agent said, not checked. Excerpts are cut to 120 characters and cleaned of markers and secrets.", ""];
  const blocks: string[] = [];
  for (const agent of sorted(ctx.agents)) {
    const claims = ctx.db
      .prepare("SELECT statement, status FROM claims WHERE agent_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?")
      .all(agent.id, ctx.since, CLAIMS_SHOWN) as unknown as Array<{ statement: string; status: string }>;
    const offer = ctx.db
      .prepare("SELECT description FROM services WHERE agent_id = ? AND updated_at >= ?")
      .get(agent.id, ctx.since) as { description: string } | undefined;
    const endpoints = ctx.db
      .prepare("SELECT name FROM endpoints WHERE agent_id = ? AND updated_at >= ? AND (status = 'live' OR status IS NULL) ORDER BY name")
      .all(agent.id, ctx.since) as unknown as Array<{ name: string }>;
    if (claims.length === 0 && !offer && endpoints.length === 0) continue;
    const name = label(agent.name);
    const body = [`<<<AGENT_SAID agent=${name}>>>`];
    for (const claim of [...claims].reverse()) body.push(`claim [${claim.status}]: ${said(claim.statement)}`);
    if (offer) body.push(`offer: ${said(offer.description)}`);
    for (const endpoint of endpoints) body.push(`endpoint: ${said(endpoint.name)}`);
    body.push("<<<END_AGENT_SAID>>>", "");
    blocks.push(...body);
  }
  if (blocks.length === 0) lines.push(NONE, "");
  else lines.push(...blocks);
  return lines;
}

export function claimsLines(ctx: ReportContext): string[] {
  const rows = ctx.db
    .prepare("SELECT agent_id, status, evidence_ids FROM claims WHERE created_at >= ?")
    .all(ctx.since) as unknown as Array<{ agent_id: string; status: string; evidence_ids: string }>;
  const lines = ["## Claims (verified/unverified)", ""];
  if (rows.length === 0) {
    lines.push(NONE, "");
    return lines;
  }
  lines.push('Last 24 hours. "Verified" means every cited evidence id is one of the agent\'s own usable evidence rows. It does not mean the statement is true.', "");
  const byAgent = new Map<string, { verified: number; unverified: number; withEvidence: number; without: number }>();
  for (const row of rows) {
    const entry = byAgent.get(row.agent_id) ?? { verified: 0, unverified: 0, withEvidence: 0, without: 0 };
    if (row.status === "verified") entry.verified += 1;
    else entry.unverified += 1;
    let ids = 0;
    try {
      const parsed = JSON.parse(row.evidence_ids) as unknown;
      ids = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      ids = 0;
    }
    if (ids > 0) entry.withEvidence += 1;
    else entry.without += 1;
    byAgent.set(row.agent_id, entry);
  }
  const entries = [...byAgent.entries()].map(([id, value]) => ({ name: label(ctx.names.get(id) ?? id), value }));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const { name, value } of entries) {
    lines.push(`- ${name}: verified ${value.verified}, unverified ${value.unverified} (with evidence ${value.withEvidence}, without evidence ${value.without})`);
  }
  lines.push("");
  return lines;
}

export function offersLines(ctx: ReportContext): string[] {
  const lines = ["## Offers and test deliveries", ""];
  const stats = new Map<string, { published: number; refused: number; unpublished: number; passing: number; failing: number }>();
  const stat = (id: string) => {
    const entry = stats.get(id) ?? { published: 0, refused: 0, unpublished: 0, passing: 0, failing: 0 };
    stats.set(id, entry);
    return entry;
  };
  const events = ctx.db
    .prepare("SELECT agent_id, kind, message FROM events WHERE created_at >= ? AND kind IN ('serve_endpoint', 'offer_service', 'offer_unpublished') AND agent_id IS NOT NULL")
    .all(ctx.since) as unknown as Array<{ agent_id: string; kind: string; message: string }>;
  for (const event of events) {
    if (event.kind === "offer_unpublished") stat(event.agent_id).unpublished += 1;
    else if (event.message.startsWith("outcome=refused")) stat(event.agent_id).refused += 1;
    else if (event.kind === "serve_endpoint" && event.message.startsWith("outcome=ok")) stat(event.agent_id).published += 1;
  }
  const services = ctx.db.prepare("SELECT agent_id FROM services WHERE updated_at >= ?").all(ctx.since) as unknown as Array<{ agent_id: string }>;
  for (const service of services) stat(service.agent_id).published += 1;
  const deliveries = ctx.db
    .prepare("SELECT agent_id, value FROM facts WHERE kind = 'test_delivery' AND created_at >= ?")
    .all(ctx.since) as unknown as Array<{ agent_id: string; value: string }>;
  for (const delivery of deliveries) {
    if (OK_DELIVERY.test(delivery.value)) stat(delivery.agent_id).passing += 1;
    else stat(delivery.agent_id).failing += 1;
  }
  if (stats.size === 0) {
    lines.push(NONE, "");
    return lines;
  }
  lines.push("Last 24 hours. Published counts offers and endpoints. Pages are not offers.", "");
  const entries = [...stats.entries()].map(([id, value]) => ({ name: label(ctx.names.get(id) ?? id), value }));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const { name, value } of entries) {
    lines.push(
      `- ${name}: published ${value.published}, refused ${value.refused}, unpublished after failed re-tests ${value.unpublished}, test deliveries passing ${value.passing}, not passing ${value.failing}`,
    );
  }
  lines.push("");
  return lines;
}

function sumLedger(ctx: ReportContext, agentId: string, where: string, ...params: Array<string | number>): number {
  return count(ctx, `SELECT COALESCE(SUM(amount_units), 0) AS n FROM ledger_entries WHERE agent_id = ? AND created_at >= ? AND ${where}`, agentId, ctx.since, ...params);
}

export function moneyLines(ctx: ReportContext): string[] {
  const lines = ["## Money (outside vs sibling, net of cost)", ""];
  if (ctx.agents.length === 0) {
    lines.push(NONE, "");
    return lines;
  }
  lines.push("Last 24 hours, from the ledger. Outside income is the line labelled; the others are not.", "");
  for (const agent of sorted(ctx.agents)) {
    const inbound = "kind IN ('onchain_income', 'x402_in') AND amount_units > 0";
    const outside = sumLedger(ctx, agent.id, `${inbound} AND (payer_class IS NULL OR payer_class != 'sibling')`);
    const sibling = sumLedger(ctx, agent.id, `${inbound} AND payer_class = 'sibling'`);
    const costs = -sumLedger(ctx, agent.id, `kind IN (${COST_MARKS})`, ...COST_KINDS);
    const topups = sumLedger(ctx, agent.id, "kind = 'owner_topup'");
    const endowments = sumLedger(ctx, agent.id, "kind = 'replication_in'");
    lines.push(
      `### ${label(agent.name)}`,
      `- outside income: ${formatUsd(outside)} (real-world signal)`,
      `- sibling income: ${formatUsd(sibling)} (not a real-world signal)`,
      `- costs: ${formatUsd(costs)}`,
      `- net of cost (outside income minus costs): ${formatUsd(outside - costs)}`,
      `- owner top-ups: ${formatUsd(topups)} (subsidy, not income)`,
      `- replication endowments: ${formatUsd(endowments)} (subsidy, not income)`,
      "",
    );
  }
  return lines;
}

export function sensesLines(ctx: ReportContext): string[] {
  const lines = ["## Senses usage", ""];
  const rows = ctx.db
    .prepare(`SELECT agent_id, tool, COUNT(*) AS n FROM evidence WHERE created_at >= ? AND tool IN (${SENSE_MARKS}) GROUP BY agent_id, tool`)
    .all(ctx.since, ...SENSE_LIST) as unknown as Array<{ agent_id: string; tool: string; n: number }>;
  const costs = ctx.db
    .prepare(`SELECT agent_id, COALESCE(SUM(-amount_units), 0) AS n FROM ledger_entries WHERE kind = 'tool' AND note IN (${SENSE_MARKS}) AND created_at >= ? GROUP BY agent_id`)
    .all(...SENSE_LIST, ctx.since) as unknown as Array<{ agent_id: string; n: number }>;
  const ids = [...new Set([...rows.map((row) => row.agent_id), ...costs.filter((row) => row.n !== 0).map((row) => row.agent_id)])];
  if (ids.length === 0) {
    lines.push(NONE, "");
    return lines;
  }
  lines.push("Last 24 hours. Calls are the evidence rows. Cost is what the agent's ledger paid for sense tools.", "");
  const total = (id: string, tools: string[]) => rows.filter((row) => row.agent_id === id && tools.includes(row.tool)).reduce((sum, row) => sum + row.n, 0);
  const entries = ids.map((id) => ({
    name: label(ctx.names.get(id) ?? id),
    line: `searches ${total(id, SEARCH_TOOLS)}, feeds ${total(id, FEED_TOOLS)}, page views ${total(id, VIEW_TOOLS)}, browse calls ${total(id, BROWSE_TOOLS)}, cost ${formatUsd(costs.find((row) => row.agent_id === id)?.n ?? 0)}`,
  }));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) lines.push(`- ${entry.name}: ${entry.line}`);
  lines.push("");
  return lines;
}

export function lostWakesLines(ctx: ReportContext): string[] {
  const lines = ["## Lost wakes", ""];
  const turns = count(ctx, "SELECT COUNT(*) AS n FROM turns WHERE created_at >= ?", ctx.since);
  const events = ctx.db
    .prepare("SELECT agent_id, message FROM events WHERE kind = 'lost_wake' AND created_at >= ? AND agent_id IS NOT NULL")
    .all(ctx.since) as unknown as Array<{ agent_id: string; message: string }>;
  lines.push("Last 24 hours. A lost wake is a turn where every model failed. Nothing is debited for it.", "");
  lines.push(events.length === 0 && turns === 0 ? NONE : `Rate: ${events.length} of ${turns} turns (${percent(events.length, turns)})`, "");
  if (events.length === 0) {
    if (turns > 0) lines.push(NONE, "");
    return lines;
  }
  const perAgent = new Map<string, number>();
  const reasons = new Map<string, number>();
  for (const event of events) {
    perAgent.set(event.agent_id, (perAgent.get(event.agent_id) ?? 0) + 1);
    const reason = /reason=(.*)$/.exec(event.message)?.[1] ?? event.message;
    const clean = sanitizeSenseText(reason).replace(/\s+/g, " ").trim().slice(0, REASON_CHARS);
    reasons.set(clean, (reasons.get(clean) ?? 0) + 1);
  }
  const entries = [...perAgent.entries()].map(([id, n]) => ({
    name: label(ctx.names.get(id) ?? id),
    turns: count(ctx, "SELECT COUNT(*) AS n FROM turns WHERE agent_id = ? AND created_at >= ?", id, ctx.since),
    n,
  }));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) lines.push(`- ${entry.name}: ${entry.n} of ${entry.turns} turns (${percent(entry.n, entry.turns)})`);
  lines.push("", "Reasons:");
  for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) lines.push(`- ${reason}: ${n}`);
  lines.push("");
  return lines;
}

/** A tripwire hit is a scan that flagged the text: an evidence row with flags, or a claim scanned above low (low is the clean baseline). */
export function breachesLines(ctx: ReportContext): string[] {
  const lines = ["## Breaches", ""];
  const hits = new Map<string, number>();
  const add = (rows: Array<{ agent_id: string; n: number }>) => {
    for (const row of rows) hits.set(row.agent_id, (hits.get(row.agent_id) ?? 0) + row.n);
  };
  add(ctx.db.prepare("SELECT agent_id, COUNT(*) AS n FROM evidence WHERE flags != '' AND created_at >= ? GROUP BY agent_id").all(ctx.since) as unknown as Array<{ agent_id: string; n: number }>);
  add(ctx.db.prepare("SELECT agent_id, COUNT(*) AS n FROM claims WHERE threat_level NOT IN ('none', 'low') AND created_at >= ? GROUP BY agent_id").all(ctx.since) as unknown as Array<{ agent_id: string; n: number }>);
  const events = ctx.db
    .prepare("SELECT agent_id, kind, COUNT(*) AS n FROM events WHERE kind IN ('breach', 'ledger_drift') AND created_at >= ? GROUP BY agent_id, kind")
    .all(ctx.since) as unknown as Array<{ agent_id: string | null; kind: string; n: number }>;
  if (hits.size === 0 && events.length === 0) {
    lines.push("None.", "");
    return lines;
  }
  lines.push("Last 24 hours. A tripwire hit is a breach attempt the runtime caught, not a breach.", "");
  const entries = [...hits.entries()].map(([id, n]) => ({ name: label(ctx.names.get(id) ?? id), n }));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) lines.push(`- ${entry.name}: ${entry.n} tripwire hit${entry.n === 1 ? "" : "s"}`);
  const named = events.map((event) => ({ name: label(event.agent_id ? (ctx.names.get(event.agent_id) ?? event.agent_id) : "swarm"), kind: event.kind, n: event.n }));
  named.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  for (const event of named) lines.push(`- ${event.name}: ${event.n} ${event.kind} event${event.n === 1 ? "" : "s"}`);
  lines.push("");
  return lines;
}
