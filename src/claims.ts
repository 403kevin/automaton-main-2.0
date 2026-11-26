import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { reviewText } from "./constitution.js";
import { formatUsd } from "./money.js";
import { OK_DELIVERY, settledPredictionLines } from "./predictions.js";
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
  // Last: a milestone the runtime's own tables contradict (specs/BO-4.3-honesty-public-a.md).
  const contradiction = contradictsFacts(db, agentId, statement);
  if (contradiction) return { ok: false, reason: contradiction, rule: "claim.contradicts_facts" };
  const status: ClaimStatus = parsed.ids.length > 0 ? "verified" : "unverified";
  const threat = guarded.level === "medium" ? "medium" : "low";
  return { ok: true, draft: { statement, evidenceIds: parsed.ids, status, threat } };
}

// Claim honesty (specs/BO-4.3-honesty-public-a.md). A conservative wording filter for three milestone families: money earned,
// an endpoint live, a test delivery passed. A statement is read clause by clause. A clause that negates, states a plan or
// expectation, or (for money) names a subsidy is skipped. Other statements are never touched, and it is not a truth oracle.
const CLAUSE_SPLIT = /[.!?;]+(?=\s|$)|\n|,(?!\d)|\s+(?:and|but|while|so|although|though)\s+/i;
const NEGATION =
  /\b(?:no|not|never|zero|none|nothing|nobody|without|cannot|(?:have|has|had|did|do|does|was|were|is|are|will|would|could|can|should)n'?t|won'?t|can'?t|yet to|still waiting|awaiting|waiting)\b/i;
const FUTURE =
  /\b(?:expect(?:s|ed|ing)?|hope(?:s|d)?|hoping|plan(?:s|ned|ning)?|will|would|could|should|might|may|want(?:s|ed)?|wish(?:es)?|aims?|aiming|goal|target|intend(?:s|ed)?|if|whether|going to|gonna|try|trying|need to|to earn|to receive|to be paid)\b|'ll\b/i;
const SUBSIDY = /\b(?:top-?ups?|topped|endowments?|seed(?:ed)?|funded|funding|deposit(?:ed)?|allowance|grants?|gifts?|owner|parent|creator)\b/i;

const TECH = "(?:endpoints?|handlers?|routes?|links?|pages?|headers?|flows?|signatures?|challenges?|address(?:es)?|wallets?|tests?|tools?|code|files?|urls?|prices?|requests?|required|network)";
const AMOUNT_TEXT = String.raw`\$\s?\d|\d[\d,]*(?:\.\d+)?\s*(?:usdc|usd|dollars?)\b`;
const MONEY_ANY = `(?:${AMOUNT_TEXT}|(?:usdc|usd|dollars?|money|income|revenue|payments?|sales?|profit|earnings|cash|funds)\\b(?!\\s+${TECH}\\b))`;
const MONEY_MADE = `(?:${AMOUNT_TEXT}|(?:money|income|revenue|sales?|profit|earnings|cash)\\b(?!\\s+${TECH}\\b))`;
const MONEY_RECEIVED = new RegExp(`\\b(?:earned|received|collected|banked|netted|pocketed|gained|generated|booked|took\\s+in)\\b.{0,40}?${MONEY_ANY}`, "i");
const MONEY_MADE_RE = new RegExp(`\\bmade\\s+(?:(?:my|our|the|a|an|some|any|first|total|real|actual|new|more|another)\\s+){0,2}${MONEY_MADE}`, "i");
const MONEY_PASSIVE: readonly RegExp[] = [
  /\b(?:was|were|been|got|gotten|am|being)\s+paid\b/i,
  /\bpaid\s+(?:me|us)\b/i,
  /\b(?:buyers?|customers?|clients?|someone|somebody|users?|payers?|visitors?)\s+(?:(?:has|have|already|just|finally)\s+)*(?:paid|bought|purchased)\b/i,
  /\b(?:bought|purchased)\s+(?:my|our|from\s+me)\b/i,
];
const OUTSIDE_INCOME = /\boutside\s+(?:income|revenue|payments?|money|earnings)\b/i;
const HAVING_VERB = /\b(?:have|has|had|got|earned|received|made|collected|recorded|gained|generated|saw|seen|shows?|showed)\b/i;
const AMOUNT = /\$\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:usdc|usd|dollars?)\b/gi;
const ENDPOINT_WORD = /\bendpoints?\b/i;
const ENDPOINT_LIVE = /\b(?:live|published|on\s+sale|for\s+sale|selling|deployed|serving|online|available|listed|registered|shipped|up\s+and\s+running|running)\b/i;
const DELIVERY_WORD = /\b(?:test[\s-]+deliver(?:y|ies)|deliver(?:y|ies)[\s-]+tests?|handler[\s-]+tests?|endpoint[\s-]+tests?)\b/i;
const PASSED_WORD = /\b(?:pass(?:ed|es|ing)?|succe(?:ed|eded|eds|ss|ssful|ssfully)|ok|okay|green|worked|works)\b/i;

/** The dollar amounts named in a clause, as units, in order. */
function namedAmounts(clause: string): Array<{ index: number; units: number }> {
  const found: Array<{ index: number; units: number }> = [];
  for (const match of clause.matchAll(AMOUNT)) {
    const units = Math.round(Number((match[1] ?? match[2] ?? "").replace(/,/g, "")) * 1_000_000);
    if (Number.isFinite(units)) found.push({ index: match.index ?? 0, units });
  }
  return found;
}

function earnedIncome(db: DatabaseSync, agentId: string, outsideOnly: boolean): number {
  const outside = outsideOnly ? " AND (payer_class IS NULL OR payer_class != 'sibling')" : "";
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_units), 0) AS n FROM ledger_entries WHERE agent_id = ? AND kind IN ('onchain_income', 'x402_in') AND amount_units > 0${outside}`,
    )
    .get(agentId) as { n: number };
  return row.n;
}

/** The index where a clause starts asserting money was received, or -1. */
function moneyClaimAt(clause: string): number {
  const starts = [MONEY_RECEIVED, MONEY_MADE_RE, ...MONEY_PASSIVE].map((pattern) => pattern.exec(clause)?.index ?? -1).filter((index) => index >= 0);
  return starts.length > 0 ? Math.min(...starts) : -1;
}

function moneyContradiction(db: DatabaseSync, agentId: string, clause: string): string | null {
  if (SUBSIDY.test(clause)) return null;
  const amounts = namedAmounts(clause);
  if (amounts.length > 0 && amounts.every((item) => item.units === 0)) return null;
  const outside = OUTSIDE_INCOME.test(clause) && (HAVING_VERB.test(clause) || amounts.length > 0);
  const at = outside ? 0 : moneyClaimAt(clause);
  if (at < 0) return null;
  const named = (amounts.find((item) => item.index >= at) ?? amounts[0])?.units;
  const recorded = earnedIncome(db, agentId, outside);
  const what = outside ? "outside income" : "earned income";
  if (recorded === 0) return `Your ledger records no ${what}, so a claim of receiving money contradicts the runtime's records.`;
  if (named !== undefined && named > recorded) {
    return `Your ledger records ${formatUsd(recorded)} of ${what}, less than the ${formatUsd(named)} this claim names.`;
  }
  return null;
}

function endpointContradiction(db: DatabaseSync, agentId: string, clause: string): string | null {
  if (!ENDPOINT_WORD.test(clause) || !ENDPOINT_LIVE.test(clause)) return null;
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM endpoints WHERE agent_id = ? AND (status = 'live' OR status IS NULL)")
    .get(agentId) as { n: number };
  return row.n > 0 ? null : "You have no live endpoint, so a claim that an endpoint is live contradicts the runtime's records.";
}

function deliveryContradiction(db: DatabaseSync, agentId: string, clause: string): string | null {
  if (!DELIVERY_WORD.test(clause) || !PASSED_WORD.test(clause)) return null;
  const rows = db.prepare("SELECT value FROM facts WHERE agent_id = ? AND kind = 'test_delivery'").all(agentId) as unknown as Array<{ value: string }>;
  if (rows.some((row) => OK_DELIVERY.test(row.value))) return null;
  return "The runtime has no passing test delivery for you, so a claim that a test delivery passed contradicts its records.";
}

/** The reason a statement contradicts the ledger, the endpoints or the facts, or null. */
function contradictsFacts(db: DatabaseSync, agentId: string, statement: string): string | null {
  for (const part of statement.replace(/[\u2018\u2019]/g, "'").split(CLAUSE_SPLIT)) {
    const clause = part.trim();
    if (!clause || NEGATION.test(clause) || FUTURE.test(clause)) continue;
    const found = moneyContradiction(db, agentId, clause) ?? endpointContradiction(db, agentId, clause) ?? deliveryContradiction(db, agentId, clause);
    if (found) return found;
  }
  return null;
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
