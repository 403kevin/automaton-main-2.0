import type { DatabaseSync } from "node:sqlite";
import { sanitizeSenseText } from "./tripwires.js";

/**
 * The "## Model reliability" section of the daily report (specs/BO-2.4-model-reliability.md): lost wakes per agent, and how many
 * turns each model actually served. A lost wake is a turn where every model failed; it is counted from the lost_wake events.
 * The served model of a turn is the orchestrator's own record (turns.model), never something an agent's container reports.
 */
export function modelReliabilityLines(db: DatabaseSync, since: number, names: Map<string, string>): string[] {
  const lost = db
    .prepare("SELECT agent_id, COUNT(*) AS n FROM events WHERE kind = 'lost_wake' AND created_at >= ? AND agent_id IS NOT NULL GROUP BY agent_id")
    .all(since) as unknown as Array<{ agent_id: string; n: number }>;
  const served = db
    .prepare("SELECT model, COUNT(*) AS n FROM turns WHERE model IS NOT NULL AND created_at >= ? GROUP BY model ORDER BY n DESC, model")
    .all(since) as unknown as Array<{ model: string; n: number }>;
  const lines = ["## Model reliability", ""];
  if (lost.length === 0 && served.length === 0) {
    lines.push("- None in the last day.", "");
    return lines;
  }
  lines.push("Last 24 hours.", "", "### Lost wakes");
  if (lost.length === 0) lines.push("- None in the last day.");
  const named = lost.map((row) => ({ name: sanitizeSenseText(names.get(row.agent_id) ?? row.agent_id), n: row.n }));
  named.sort((a, b) => a.name.localeCompare(b.name));
  for (const row of named) lines.push(`- ${row.name}: ${row.n}`);
  lines.push("", "### Turns per served model");
  if (served.length === 0) lines.push("- None in the last day.");
  for (const row of served) lines.push(`- ${sanitizeSenseText(row.model)}: ${row.n}`);
  lines.push("");
  return lines;
}
