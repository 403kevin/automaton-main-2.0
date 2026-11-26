import { buildSystemPrompt, buildWakeup } from "../prompt.js";
import { fitNotes } from "../tripwires.js";
import type { AgentSnapshot, ChatMessage, ToolCall } from "../types.js";
import { runLocalTool, toolsForModel } from "./tools.js";

/** Characters of tool notes kept in one turn summary. A fenced sense result is cut inside its fence. */
const TURN_SUMMARY_CHARS = 1800;

export interface AgentHost {
  snapshot(agentId: string): Promise<AgentSnapshot>;
  infer(
    agentId: string,
    messages: ChatMessage[],
    tools: unknown[],
  ): Promise<
    | { skipped: true; reason: string; retryAfterMs?: number }
    | { skipped: false; content: string; toolCalls: ToolCall[]; model: string; costUnits: number }
  >;
  authorizeTool(
    agentId: string,
    call: ToolCall,
  ): Promise<{ ok: true; handled: boolean; output?: string } | { ok: false; reason: string }>;
  recordTurn(agentId: string, text: string): Promise<void>;
  /** Report a refusal that happened in the agent's own process (a local shell, path or symlink rule). */
  recordRefusal(agentId: string, tool: string, rule: string, reason: string): Promise<void>;
}

/** Tools whose use (not refused) makes a turn productive for the idle brake: they build, ship, or read a demand feed. */
export const PRODUCTIVE_TOOLS: ReadonlySet<string> = new Set(["write_file", "shell", "serve_endpoint", "publish_page", "read_feed"]);

/** The most the idle brake stretches the wait, as a multiple of the normal turn interval (40 minutes at five-minute turns). */
export const IDLE_BRAKE_MAX_FACTOR = 8;

/**
 * The wait after a turn. At the normal interval until the idle streak reaches `brakeTurns`, then doubled for each further
 * idle turn, never above IDLE_BRAKE_MAX_FACTOR times the interval. `brakeTurns` of 0 (or less, or not a number) is off.
 */
export function idleBrakeWait(sleepMs: number, idleStreak: number, brakeTurns: number): number {
  if (!(brakeTurns > 0) || idleStreak < brakeTurns) return sleepMs;
  return Math.min(sleepMs * 2 ** (idleStreak - brakeTurns + 1), sleepMs * IDLE_BRAKE_MAX_FACTOR);
}

export async function runAgentLoop(input: {
  agentId: string;
  host: AgentHost;
  signal: AbortSignal;
  workspace: string;
  denyHosts: string[];
  sleepMs: number;
  /** Idle turns in a row before the wait grows. 0 or unset is off. */
  idleBrakeTurns?: number;
  /** The wait between turns. Defaults to a timer that ends at once on abort. A test passes its own to read the waits. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const wait = input.sleep ?? sleep;
  const brakeTurns = input.idleBrakeTurns ?? 0;
  let idleStreak = 0;
  while (!input.signal.aborted) {
    let waitMs = input.sleepMs;
    try {
      const outcome = await oneTurn(input);
      // Only a served turn moves the streak. A skipped inference, a kill-switch turn and a failed turn leave it alone.
      if (outcome.served) idleStreak = outcome.productive ? 0 : idleStreak + 1;
      waitMs = outcome.retryAfterMs !== undefined ? outcome.retryAfterMs : idleBrakeWait(input.sleepMs, idleStreak, brakeTurns);
    } catch (error) {
      const message = error instanceof Error ? error.message : "turn failed";
      await input.host.recordTurn(input.agentId, `Turn error: ${message}`).catch(() => undefined);
    }
    await wait(waitMs, input.signal);
  }
}

async function oneTurn(input: {
  agentId: string;
  host: AgentHost;
  workspace: string;
  denyHosts: string[];
}): Promise<{ retryAfterMs?: number; served?: boolean; productive?: boolean }> {
  const snapshot = await input.host.snapshot(input.agentId);
  if (snapshot.killSwitch || snapshot.status !== "running") {
    await input.host.recordTurn(input.agentId, snapshot.killSwitch ? "Kill switch is on. Idle." : `Idle while ${snapshot.status}.`);
    return {};
  }
  const tools = toolsForModel();
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(snapshot) },
    { role: "user", content: buildWakeup(snapshot) },
  ];
  const first = await input.host.infer(input.agentId, messages, tools);
  if (first.skipped) {
    await input.host.recordTurn(input.agentId, `Inference skipped: ${first.reason}`);
    return { retryAfterMs: first.retryAfterMs };
  }
  if (first.toolCalls.length === 0) {
    await input.host.recordTurn(input.agentId, first.content || "(empty thought)");
    return { served: true, productive: false };
  }
  const notes: string[] = [];
  let productive = false;
  for (const call of first.toolCalls) {
    const auth = await input.host.authorizeTool(input.agentId, call);
    if (!auth.ok) {
      notes.push(`${call.name}: refused: ${auth.reason}`);
      continue;
    }
    if (auth.handled) {
      if (PRODUCTIVE_TOOLS.has(call.name)) productive = true;
      notes.push(`${call.name}: ${auth.output ?? "ok"}`);
      continue;
    }
    const local = await runLocalTool({ workspace: input.workspace, call, denyHosts: input.denyHosts });
    if (local.refusal) {
      // A failure to report must never break the turn.
      await input.host.recordRefusal(input.agentId, call.name, local.refusal.rule, local.output).catch(() => undefined);
    } else if (PRODUCTIVE_TOOLS.has(call.name)) {
      productive = true;
    }
    notes.push(`${call.name}: ${local.output}`);
  }
  const summary = fitNotes(notes, TURN_SUMMARY_CHARS);
  await input.host.recordTurn(input.agentId, summary || first.content || "Acted.");
  return { served: true, productive };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
