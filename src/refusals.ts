import type { DatabaseSync } from "node:sqlite";
import { sanitizeSenseText } from "./tripwires.js";

/**
 * Refusal records (specs/BO-2.3-refusal-records.md). One row for every refused tool call, with a rule ID from a closed
 * list. The list is a typed constant: nothing else is accepted, and `unclassified` is the last resort.
 */
export const RULE_IDS = [
  "kill_switch",
  "agent_status",
  "unknown_tool",
  "constitution.I",
  "constitution.II",
  "constitution.III",
  "owner.denylist",
  "spend.cap",
  "spend.cap.hourly",
  "ledger.balance",
  "ledger.duplicate",
  "limit.hourly.see_page",
  "limit.hourly.crawl_site",
  "limit.hourly.read_feed",
  "limit.hourly.browse",
  "limit.hourly.claim",
  "limit.hourly.predict",
  "limit.repeat_search",
  "limit.offer_checks",
  "claim.evidence",
  "claim.shape",
  "claim.tripwire",
  "claim.contradicts_facts",
  "predict.shape",
  "predict.open_cap",
  "predict.tripwire",
  "income.self_declared",
  "offer.test_failed",
  "offer.unconfigured",
  "offer.body_empty",
  "offer.link_own_missing",
  "offer.link_dead",
  "offer.cap",
  "offer.price",
  "offer.handler",
  "input.invalid",
  "input.conflict",
  "tool.disabled",
  "tool.unconfigured",
  "tool.failed",
  "sense.refused",
  "sense.error",
  "spawn.refused",
  "council.refused",
  "pay.refused",
  "local.shell",
  "local.path",
  "local.symlink",
  "unclassified",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/** A refused tool call. The rule travels with the result so the one write point can record it. */
export type RefusalResult = { ok: false; reason: string; rule?: RuleId };

const KNOWN = new Set<string>(RULE_IDS);

/** The only rules the agent's own process may report: it can see a symlink's real path, the orchestrator cannot. */
export const LOCAL_RULE_IDS: readonly RuleId[] = ["local.shell", "local.path", "local.symlink"];

/** Refusals that cost nothing but ran the sandbox or sent outside requests. They count toward OFFER_CHECK_HOURLY_LIMIT. */
export const OFFER_CHECK_RULES: readonly RuleId[] = ["offer.test_failed", "offer.link_dead", "offer.link_own_missing"];

export const REASON_MAX_CHARS = 300;
export const TOOL_MAX_CHARS = 60;
/** The most agent-reported rows kept per agent per hour: a bound on what a compromised container can write. */
export const AGENT_REFUSAL_HOURLY_MAX = 200;
export const REFUSAL_WINDOW_MS = 3_600_000;

export function asRuleId(value: unknown): RuleId {
  return typeof value === "string" && KNOWN.has(value) ? (value as RuleId) : "unclassified";
}

export function asLocalRuleId(value: unknown): RuleId {
  return LOCAL_RULE_IDS.includes(value as RuleId) ? (value as RuleId) : "unclassified";
}

/** The rule for a constitution review: the law that refused, or the owner denylist. */
export function ruleForLaw(law: string | undefined): RuleId {
  if (law === "owner") return "owner.denylist";
  if (law === "I" || law === "II" || law === "III") return `constitution.${law}`;
  return "unclassified";
}

export function cleanReason(reason: string): string {
  return sanitizeSenseText(reason).slice(0, REASON_MAX_CHARS);
}

/** A tool name from the agent's container: short, lowercase letters and underscores, or "unknown". */
export function cleanAgentTool(tool: unknown): string {
  return typeof tool === "string" && /^[a-z_]{1,40}$/.test(tool) ? tool : "unknown";
}

export function insertRefusal(
  db: DatabaseSync,
  row: { agentId: string; tool: string; rule: RuleId; reason: string; source: "runtime" | "agent"; now: number },
): void {
  db.prepare("INSERT INTO refusals (agent_id, tool, rule_id, reason, source, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    row.agentId,
    sanitizeSenseText(row.tool).slice(0, TOOL_MAX_CHARS),
    row.rule,
    cleanReason(row.reason),
    row.source,
    row.now,
  );
}

/** Runtime-recorded refusals of the given rules for one agent since a time. */
export function countRuntimeRefusals(db: DatabaseSync, agentId: string, rules: readonly RuleId[], since: number): number {
  const marks = rules.map(() => "?").join(", ");
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM refusals WHERE agent_id = ? AND source = 'runtime' AND created_at > ? AND rule_id IN (${marks})`)
    .get(agentId, since, ...rules) as { n: number };
  return row.n;
}

export function countAgentReported(db: DatabaseSync, agentId: string, since: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM refusals WHERE agent_id = ? AND source = 'agent' AND created_at > ?")
    .get(agentId, since) as { n: number };
  return row.n;
}

interface CountRow {
  agent_id: string;
  rule_id: string;
  n: number;
}

function countsBySource(db: DatabaseSync, source: "runtime" | "agent", since: number): CountRow[] {
  return db
    .prepare(
      "SELECT agent_id, rule_id, COUNT(*) AS n FROM refusals WHERE source = ? AND created_at >= ? GROUP BY agent_id, rule_id ORDER BY agent_id, rule_id",
    )
    .all(source, since) as unknown as CountRow[];
}

function totalsByRule(rows: CountRow[]): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.rule_id, (totals.get(row.rule_id) ?? 0) + row.n);
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function perAgentLines(rows: CountRow[], names: Map<string, string>): string[] {
  const byAgent = new Map<string, string[]>();
  for (const row of rows) {
    const list = byAgent.get(row.agent_id) ?? [];
    list.push(`${row.rule_id} ${row.n}`);
    byAgent.set(row.agent_id, list);
  }
  return [...byAgent.entries()].map(([agentId, parts]) => `- ${names.get(agentId) ?? agentId}: ${parts.join(", ")}`);
}

/** The "## Refusals" section of the daily report: counts by rule in total and per agent, agent-reported rows apart. */
export function refusalReportLines(db: DatabaseSync, since: number, names: Map<string, string>): string[] {
  const runtime = countsBySource(db, "runtime", since);
  const agent = countsBySource(db, "agent", since);
  const lines = ["## Refusals", ""];
  if (runtime.length === 0 && agent.length === 0) {
    lines.push("- None in the last day.", "");
    return lines;
  }
  lines.push("Last 24 hours. Runtime-recorded rows are written by the orchestrator.", "");
  const runtimeTotal = runtime.reduce((sum, row) => sum + row.n, 0);
  lines.push(`### Runtime-recorded (total ${runtimeTotal})`);
  if (runtime.length === 0) lines.push("- None in the last day.");
  for (const [rule, n] of totalsByRule(runtime)) lines.push(`- ${rule}: ${n}`);
  if (runtime.length > 0) lines.push("", "By agent:", ...perAgentLines(runtime, names));
  lines.push("");
  if (agent.length > 0) {
    const agentTotal = agent.reduce((sum, row) => sum + row.n, 0);
    lines.push(
      `### Agent-reported (lower trust, total ${agentTotal})`,
      "Reported by the agent's own process, which could send anything. Treat these as hints, not evidence.",
    );
    for (const [rule, n] of totalsByRule(agent)) lines.push(`- ${rule}: ${n}`);
    lines.push("", "By agent:", ...perAgentLines(agent, names), "");
  }
  return lines;
}
