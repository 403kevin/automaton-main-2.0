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

export async function runAgentLoop(input: {
  agentId: string;
  host: AgentHost;
  signal: AbortSignal;
  workspace: string;
  denyHosts: string[];
  sleepMs: number;
}): Promise<void> {
  while (!input.signal.aborted) {
    let waitMs = input.sleepMs;
    try {
      const outcome = await oneTurn(input);
      if (outcome.retryAfterMs !== undefined) waitMs = outcome.retryAfterMs;
    } catch (error) {
      const message = error instanceof Error ? error.message : "turn failed";
      await input.host.recordTurn(input.agentId, `Turn error: ${message}`).catch(() => undefined);
    }
    await sleep(waitMs, input.signal);
  }
}

async function oneTurn(input: {
  agentId: string;
  host: AgentHost;
  workspace: string;
  denyHosts: string[];
}): Promise<{ retryAfterMs?: number }> {
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
    return {};
  }
  const notes: string[] = [];
  for (const call of first.toolCalls) {
    const auth = await input.host.authorizeTool(input.agentId, call);
    if (!auth.ok) {
      notes.push(`${call.name}: refused: ${auth.reason}`);
      continue;
    }
    if (auth.handled) {
      notes.push(`${call.name}: ${auth.output ?? "ok"}`);
      continue;
    }
    const local = await runLocalTool({ workspace: input.workspace, call, denyHosts: input.denyHosts });
    if (local.refusal) {
      // A failure to report must never break the turn.
      await input.host.recordRefusal(input.agentId, call.name, local.refusal.rule, local.output).catch(() => undefined);
    }
    notes.push(`${call.name}: ${local.output}`);
  }
  const summary = fitNotes(notes, TURN_SUMMARY_CHARS);
  await input.host.recordTurn(input.agentId, summary || first.content || "Acted.");
  return {};
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
