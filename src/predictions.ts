import type { DatabaseSync } from "node:sqlite";
import { sanitizeSenseText } from "./tripwires.js";

/**
 * Predictions and their settlement (specs/BO-2.7-predict-settlement.md). The runtime only keeps score: an agent commits to a
 * number before the fact, and at the deadline the runtime computes the actual value from that agent's own facts.
 */

export const METRICS = ["income_outside_units", "income_sibling_units", "test_deliveries_ok", "sense_results"] as const;
export type Metric = (typeof METRICS)[number];

export const OPS = [">=", "<=", "="] as const;
export type Op = (typeof OPS)[number];

export const PREDICT_MAX_OPEN = 20;
export const PREDICT_NOTE_MAX_CHARS = 300;
export const PREDICT_MIN_HOURS = 1;
export const PREDICT_MAX_HOURS = 168;
export const HOUR_MS = 3_600_000;
/** The most settled predictions shown to the agent in its own records. */
export const OWN_SETTLED_SHOWN = 5;

export interface PredictInput {
  metric: Metric;
  op: Op;
  value: number;
  hours: number;
  note: string | null;
}

export type PredictParse = { ok: true; input: PredictInput } | { ok: false; reason: string };

function wholeNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isSafeInteger(raw) ? raw : null;
  if (typeof raw === "string" && /^\d{1,15}$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

/** Check the shape of a predict call: the metric, op, value, deadline and the note's length. Says nothing of the note's content. */
export function parsePredictInput(args: Record<string, unknown>): PredictParse {
  const metric = args.metric;
  if (typeof metric !== "string" || !(METRICS as readonly string[]).includes(metric)) {
    return { ok: false, reason: `metric must be one of ${METRICS.join(", ")}.` };
  }
  const op = args.op;
  if (typeof op !== "string" || !(OPS as readonly string[]).includes(op)) {
    return { ok: false, reason: `op must be one of ${OPS.join(", ")}.` };
  }
  const value = wholeNumber(args.value);
  if (value === null || value < 0) return { ok: false, reason: "value must be a whole number of 0 or more." };
  const hours = wholeNumber(args.deadline_hours);
  if (hours === null || hours < PREDICT_MIN_HOURS || hours > PREDICT_MAX_HOURS) {
    return { ok: false, reason: `deadline_hours must be a whole number from ${PREDICT_MIN_HOURS} to ${PREDICT_MAX_HOURS}.` };
  }
  let note: string | null = null;
  if (args.note !== undefined && args.note !== null) {
    if (typeof args.note !== "string") return { ok: false, reason: "note must be text." };
    const trimmed = args.note.trim();
    if (trimmed.length > PREDICT_NOTE_MAX_CHARS) return { ok: false, reason: `note is longer than ${PREDICT_NOTE_MAX_CHARS} characters.` };
    note = trimmed === "" ? null : trimmed;
  }
  return { ok: true, input: { metric: metric as Metric, op: op as Op, value, hours, note } };
}

export function openCount(db: DatabaseSync, agentId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM predictions WHERE agent_id = ? AND status = 'open'").get(agentId) as { n: number };
  return row.n;
}

/**
 * Attempts in the window: stored predictions plus refused ones. A refusal for the limit itself is not an attempt, so an
 * agent that keeps trying does not extend its own lockout.
 */
export function predictAttempts(db: DatabaseSync, agentId: string, since: number): number {
  const stored = db.prepare("SELECT COUNT(*) AS n FROM predictions WHERE agent_id = ? AND created_at > ?").get(agentId, since) as { n: number };
  const refused = db
    .prepare(
      "SELECT COUNT(*) AS n FROM refusals WHERE agent_id = ? AND source = 'runtime' AND tool = 'predict' AND rule_id != 'limit.hourly.predict' AND created_at > ?",
    )
    .get(agentId, since) as { n: number };
  return stored.n + refused.n;
}

export function insertPrediction(db: DatabaseSync, agentId: string, input: PredictInput, now: number): number {
  const result = db
    .prepare("INSERT INTO predictions (agent_id, metric, op, value, note, created_at, deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(agentId, input.metric, input.op, input.value, input.note, now, now + input.hours * HOUR_MS);
  return Number(result.lastInsertRowid);
}

const CREDIT_VALUE = /^units=(\d+) payer_class=([a-z_]+)$/;
const OK_DELIVERY = /^code=ok bytes=\d+$/;

interface FactRow {
  subject: string;
  value: string;
}

function factsInWindow(db: DatabaseSync, agentId: string, kind: string, after: number, upTo: number): FactRow[] {
  return db
    .prepare("SELECT subject, value FROM facts WHERE agent_id = ? AND kind = ? AND created_at > ? AND created_at <= ?")
    .all(agentId, kind, after, upTo) as unknown as FactRow[];
}

function sumCredits(rows: FactRow[], wanted: (payerClass: string) => boolean): number {
  let total = 0;
  for (const row of rows) {
    if (row.subject !== "onchain_income" && row.subject !== "x402_in") continue;
    const match = CREDIT_VALUE.exec(row.value);
    if (!match) continue;
    if (wanted(match[2] ?? "")) total += Number(match[1]);
  }
  return total;
}

/**
 * The actual value of a metric from one agent's own facts strictly after `after` and at or before `upTo`. Only the runtime
 * writes facts, in fixed formats, so the strict parsing below cannot be fed hostile text; a row that does not match is skipped.
 */
export function computeActual(db: DatabaseSync, agentId: string, metric: Metric, after: number, upTo: number): number {
  if (metric === "sense_results") return factsInWindow(db, agentId, "sense", after, upTo).length;
  if (metric === "test_deliveries_ok") {
    return factsInWindow(db, agentId, "test_delivery", after, upTo).filter((row) => OK_DELIVERY.test(row.value)).length;
  }
  const credits = factsInWindow(db, agentId, "credit", after, upTo);
  // Matches the ledger: income is onchain_income and x402_in; a missing class counts as outside; a child's endowment is a subsidy.
  if (metric === "income_sibling_units") return sumCredits(credits, (payerClass) => payerClass === "sibling");
  return sumCredits(credits, (payerClass) => payerClass !== "sibling" && payerClass !== "owner");
}

export function isHit(op: Op, actual: number, value: number): boolean {
  if (op === ">=") return actual >= value;
  if (op === "<=") return actual <= value;
  return actual === value;
}

interface DueRow {
  id: number;
  agent_id: string;
  metric: Metric;
  op: Op;
  value: number;
  created_at: number;
  deadline_at: number;
}

/**
 * Settle every open prediction whose deadline is strictly before now, for every agent (a dead agent's record is completed
 * too). A prediction settles once: the update only touches a row that is still open, so a second pass finds nothing to do.
 */
export function settlePredictions(db: DatabaseSync, now: number): number {
  const due = db
    .prepare("SELECT id, agent_id, metric, op, value, created_at, deadline_at FROM predictions WHERE status = 'open' AND deadline_at < ? ORDER BY id")
    .all(now) as unknown as DueRow[];
  let settled = 0;
  for (const row of due) {
    const actual = computeActual(db, row.agent_id, row.metric, row.created_at, row.deadline_at);
    const status = isHit(row.op, actual, row.value) ? "hit" : "miss";
    const result = db
      .prepare("UPDATE predictions SET status = ?, actual = ?, settled_at = ? WHERE id = ? AND status = 'open'")
      .run(status, actual, now, row.id);
    if (Number(result.changes) > 0) settled += 1;
  }
  return settled;
}

/** The agent's last settled predictions, newest settled first, one short line each, for its own records. */
export function settledPredictionLines(db: DatabaseSync, agentId: string): string[] {
  const rows = db
    .prepare(
      "SELECT metric, op, value, actual, status FROM predictions WHERE agent_id = ? AND status IN ('hit', 'miss') ORDER BY settled_at DESC, id DESC LIMIT ?",
    )
    .all(agentId, OWN_SETTLED_SHOWN) as unknown as Array<{ metric: string; op: string; value: number; actual: number; status: string }>;
  return rows.map((row) => `- [${row.status}] ${row.metric} ${row.op} ${row.value} -> ${row.actual}`);
}

/** The "## Predictions" section of the daily report: per agent, settled in the last day, hits, hit rate, and how many are open. */
export function predictionReportLines(db: DatabaseSync, since: number, names: Map<string, string>): string[] {
  const settled = db
    .prepare(
      "SELECT agent_id, COUNT(*) AS n, SUM(CASE WHEN status = 'hit' THEN 1 ELSE 0 END) AS hits FROM predictions WHERE status IN ('hit', 'miss') AND settled_at >= ? GROUP BY agent_id",
    )
    .all(since) as unknown as Array<{ agent_id: string; n: number; hits: number }>;
  const open = db
    .prepare("SELECT agent_id, COUNT(*) AS n FROM predictions WHERE status = 'open' GROUP BY agent_id")
    .all() as unknown as Array<{ agent_id: string; n: number }>;
  const lines = ["## Predictions", ""];
  const ids = [...new Set([...settled.map((row) => row.agent_id), ...open.map((row) => row.agent_id)])];
  if (ids.length === 0) {
    lines.push("- None in the last day.", "");
    return lines;
  }
  lines.push("Last 24 hours. Scored by the runtime from the agent's own facts.", "");
  const entries = ids.map((id) => {
    const done = settled.find((row) => row.agent_id === id);
    const waiting = open.find((row) => row.agent_id === id)?.n ?? 0;
    const count = done?.n ?? 0;
    const hits = done?.hits ?? 0;
    const rate = count > 0 ? `${Math.round((100 * hits) / count)}%` : "n/a";
    const name = sanitizeSenseText(names.get(id) ?? id);
    return { name, line: `- ${name}: settled ${count}, hits ${hits}, hit rate ${rate}, open ${waiting}` };
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) lines.push(entry.line);
  lines.push("");
  return lines;
}
