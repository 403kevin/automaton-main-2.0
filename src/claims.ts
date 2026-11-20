import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { reviewText } from "./constitution.js";
import { settledPredictionLines } from "./predictions.js";
import { ruleForLaw, type RuleId } from "./refusals.js";
import { guardSenseText, sanitizeSenseText, truncateInsideFence } from "./tripwires.js";

/**
 * Claims (written by the agent) and facts (written only by the runtime). See specs/BO-2.1b-claim-facts.md.
 * A "verified" claim means every cited evidence row is the agent's own and was a usable result. It does not mean the
 * statement is true.
 */

export const CLAIM_MAX_CHARS = 500;
export const CLAIM_MAX_EVIDENCE_IDS = 20;
export const OWN_RECORDS_MAX_CHARS = 1200;
export const OWN_RECORDS_LIMIT = 10;
const USABLE_EVIDENCE_STATUS = "ok";
const SUBJECT_CHARS = 60;
const VALUE_CHARS = 80;
const HASH_SHOWN_CHARS = 12;

export type ClaimStatus = "verified" | "unverified";

export interface ClaimDraft {
  statement: string;
  evidenceIds: number[];
  status: ClaimStatus;
  threat: "low" | "medium";
}

export type ClaimCheck = { ok: true; draft: ClaimDraft } | { ok: false; reason: string; rule: RuleId };

type IdsResult = { ok: true; ids: number[] } | { ok: false; reason: string };

/** Read evidence_ids: a list, a JSON string of a list, or nothing. Whole numbers or numeric strings, at most 20. */
export function parseEvidenceIds(value: unknown): IdsResult {
  let list: unknown = value;
  if (list === undefined || list === null || list === "") return { ok: true, ids: [] };
  if (typeof list === "string") {
    try {
      list = JSON.parse(list) as unknown;
    } catch {
      return { ok: false, reason: "evidence_ids must be a list of whole numbers." };
    }
  }
  if (!Array.isArray(list)) return { ok: false, reason: "evidence_ids must be a list of whole numbers." };
  const ids: number[] = [];
  for (const entry of list) {
    const isNumber = typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0;
    const isNumeric = typeof entry === "string" && /^[1-9]\d{0,15}$/.test(entry.trim());
    if (!isNumber && !isNumeric) {
      return { ok: false, reason: `Evidence id "${String(entry).slice(0, 40)}" is not a whole number.` };
    }
    const id = Number(entry);
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > CLAIM_MAX_EVIDENCE_IDS) {
    return { ok: false, reason: `A claim can cite at most ${CLAIM_MAX_EVIDENCE_IDS} evidence ids.` };
  }
  return { ok: true, ids };
}

/** Check a claim before anything is charged or stored. The hourly limit is the caller's check, made first. */
export function checkClaim(db: DatabaseSync, agentId: string, statementRaw: unknown, idsRaw: unknown): ClaimCheck {
  const statement = String(statementRaw ?? "").trim();
  if (!statement) return { ok: false, reason: "Statement is empty.", rule: "claim.shape" };
  if (statement.length > CLAIM_MAX_CHARS) {
    return { ok: false, reason: `Statement is longer than ${CLAIM_MAX_CHARS} characters.`, rule: "claim.shape" };
  }
  const review = reviewText(statement);
  if (!review.allowed) return { ok: false, reason: review.reason, rule: ruleForLaw(review.law) };
  const guarded = guardSenseText("claim", statement);
  if (guarded.quarantined) {
    return {
      ok: false,
      reason: `Statement looks like an attack on the agent's own memory (${guarded.flags.join(",")}).`,
      rule: "claim.tripwire",
    };
  }
  const parsed = parseEvidenceIds(idsRaw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, rule: "claim.shape" };
  for (const id of parsed.ids) {
    const row = db.prepare("SELECT agent_id, status FROM evidence WHERE id = ?").get(id) as
      | { agent_id: string; status: string }
      | undefined;
    // Unknown and foreign ids get the same reason, so the tool says nothing about other agents' rows.
    if (!row || row.agent_id !== agentId) {
      return { ok: false, reason: `Evidence id ${id} is not one of your usable evidence rows.`, rule: "claim.evidence" };
    }
    if (row.status !== USABLE_EVIDENCE_STATUS) {
      return { ok: false, reason: `Evidence id ${id} is ${row.status}, so it cannot back a claim.`, rule: "claim.evidence" };
    }
  }
  const status: ClaimStatus = parsed.ids.length > 0 ? "verified" : "unverified";
  const threat = guarded.level === "medium" ? "medium" : "low";
  return { ok: true, draft: { statement, evidenceIds: parsed.ids, status, threat } };
}

export function insertClaim(db: DatabaseSync, agentId: string, draft: ClaimDraft, now: number): number {
  const result = db
    .prepare(
      "INSERT INTO claims (agent_id, statement, evidence_ids, status, threat_level, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(agentId, draft.statement, JSON.stringify(draft.evidenceIds), draft.status, draft.threat, now);
  return Number(result.lastInsertRowid);
}

/** Only the runtime calls this. There is no tool for it. */
export function insertFact(
  db: DatabaseSync,
  fact: { agentId: string; kind: "sense" | "credit" | "test_delivery"; subject: string; value: string; source: string; now: number },
): void {
  db.prepare("INSERT INTO facts (agent_id, kind, subject, value, source, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    fact.agentId,
    fact.kind,
    fact.subject.slice(0, 500),
    fact.value.slice(0, 500),
    fact.source,
    fact.now,
  );
}

/** Attempts in the window: accepted claims plus rejected ones. Limit refusals are not attempts. */
export function claimAttempts(db: DatabaseSync, agentId: string, since: number): number {
  const stored = db.prepare("SELECT COUNT(*) AS n FROM claims WHERE agent_id = ? AND created_at > ?").get(agentId, since) as { n: number };
  const rejected = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND kind = 'claim_rejected' AND created_at > ?")
    .get(agentId, since) as { n: number };
  return stored.n + rejected.n;
}

type FactRow = { kind: string; subject: string; value: string; source: string };
type ClaimRow = { statement: string; status: string };

function oneLine(text: string, max: number): string {
  return sanitizeSenseText(text).replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The agent's own last facts and claims, newest first, as one fenced block of at most 1200 characters for the wake-up.
 * Own data only: both queries are filtered by agent id. The fence has its own marker (OWN_RECORDS) so a page that copies
 * the sense fence cannot pose as the runtime. Returns an empty string when there is nothing to show.
 */
export function ownRecords(db: DatabaseSync, agentId: string, nonce: string = randomBytes(6).toString("hex")): string {
  const facts = db
    .prepare("SELECT kind, subject, value, source FROM facts WHERE agent_id = ? ORDER BY id DESC LIMIT ?")
    .all(agentId, OWN_RECORDS_LIMIT) as unknown as FactRow[];
  const claims = db
    .prepare("SELECT statement, status FROM claims WHERE agent_id = ? ORDER BY id DESC LIMIT ?")
    .all(agentId, OWN_RECORDS_LIMIT) as unknown as ClaimRow[];
  const predictions = settledPredictionLines(db, agentId);
  if (facts.length === 0 && claims.length === 0 && predictions.length === 0) return "";
  const lines = ["Your own records. Facts are written by the runtime. Claims are yours."];
  if (facts.length > 0) {
    lines.push("Facts:");
    for (const fact of facts) {
      const value = fact.kind === "sense" ? fact.value.slice(0, HASH_SHOWN_CHARS) : fact.value;
      lines.push(`- ${fact.source} ${fact.kind} ${oneLine(fact.subject, SUBJECT_CHARS)} ${oneLine(value, VALUE_CHARS)}`);
    }
  }
  // Predictions sit between facts and claims: they are short and fixed in shape, so the long, agent-written claims give way first.
  if (predictions.length > 0) lines.push("Predictions:", ...predictions);
  if (claims.length > 0) {
    lines.push("Claims:");
    for (const claim of claims) lines.push(`- [${claim.status}] ${oneLine(claim.statement, CLAIM_MAX_CHARS)}`);
  }
  const block = [`<<<OWN_RECORDS nonce=${nonce}>>>`, ...lines, `<<<END_OWN_RECORDS nonce=${nonce}>>>`].join("\n");
  return truncateInsideFence(block, OWN_RECORDS_MAX_CHARS);
}
