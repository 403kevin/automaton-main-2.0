import type { DatabaseSync } from "node:sqlite";
import { sanitizeSenseText } from "./tripwires.js";

/**
 * The "## Model reliability" section of the daily report (specs/BO-2.4-model-reliability.md): how many turns each model actually
 * served, and what each agent was assigned. Lost wakes moved to their own section in BO-2.5 (src/report-v2.ts).
 * The served model of a turn is the orchestrator's own record (turns.model), never something an agent's container reports.
 */
export function modelReliabilityLines(
  db: DatabaseSync,
  since: number,
  _names: Map<string, string>,
  agents: Array<{ id: string; name: string; assigned: string }> = [],
): string[] {
  const served = db
    .prepare("SELECT model, COUNT(*) AS n FROM turns WHERE model IS NOT NULL AND created_at >= ? GROUP BY model ORDER BY n DESC, model")
    .all(since) as unknown as Array<{ model: string; n: number }>;
  const lines = ["## Model reliability", ""];
  if (served.length === 0) {
    lines.push("- None in the last day.", "");
    lines.push(...assignedAndServed(db, since, agents));
    return lines;
  }
  lines.push("Last 24 hours.", "", "### Turns per served model");
  for (const row of served) lines.push(`- ${sanitizeSenseText(row.model)}: ${row.n}`);
  lines.push("");
  lines.push(...assignedAndServed(db, since, agents));
  return lines;
}

/** One line per living agent: the model it was assigned and the models that actually served its turns in the last day. */
function assignedAndServed(db: DatabaseSync, since: number, agents: Array<{ id: string; name: string; assigned: string }>): string[] {
  if (agents.length === 0) return [];
  const rows = db
    .prepare("SELECT agent_id, model, COUNT(*) AS n FROM turns WHERE model IS NOT NULL AND created_at >= ? GROUP BY agent_id, model ORDER BY n DESC, model")
    .all(since) as unknown as Array<{ agent_id: string; model: string; n: number }>;
  const lines = ["### Assigned and served"];
  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  for (const agent of sorted) {
    const served = rows.filter((row) => row.agent_id === agent.id).map((row) => `${sanitizeSenseText(row.model)} ${row.n}`);
    lines.push(`- ${sanitizeSenseText(agent.name)}: assigned ${sanitizeSenseText(agent.assigned)} -> served ${served.length ? served.join(", ") : "none"}`);
  }
  lines.push("");
  return lines;
}
