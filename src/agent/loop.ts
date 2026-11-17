import { buildSystemPrompt, buildWakeup } from "../prompt.js";
import type { AgentSnapshot, ChatMessage, ToolCall } from "../types.js";
import { executeLocalTool, toolsForModel } from "./tools.js";

export interface AgentHost {
  snapshot(agentId: string): Promise<AgentSnapshot>;
  infer(
    agentId: string,
    messages: ChatMessage[],
    tools: unknown[],
  ): Promise<
    | { skipped: true; reason: string }
    | { skipped: false; content: string; toolCalls: ToolCall[]; model: string; costUnits: number }
  >;
  authorizeTool(
    agentId: string,
    call: ToolCall,
  ): Promise<{ ok: true; handled: boolean; output?: string } | { ok: false; reason: string }>;
  recordTurn(agentId: string, text: string): Promise<void>;
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
    try {
      await oneTurn(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : "turn failed";
      await input.host.recordTurn(input.agentId, `Turn error: ${message}`).catch(() => undefined);
    }
    await sleep(input.sleepMs, input.signal);
  }
}

async function oneTurn(input: {
  agentId: string;
  host: AgentHost;
  workspace: string;
  denyHosts: string[];
}): Promise<void> {
  const snapshot = await input.host.snapshot(input.agentId);
  if (snapshot.killSwitch || snapshot.status !== "running") {
    await input.host.recordTurn(input.agentId, snapshot.killSwitch ? "Kill switch is on. Idle." : `Idle while ${snapshot.status}.`);
    return;
  }
  const tools = toolsForModel();
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(snapshot) },
    { role: "user", content: buildWakeup(snapshot) },
  ];
  const first = await input.host.infer(input.agentId, messages, tools);
  if (first.skipped) {
    await input.host.recordTurn(input.agentId, `Inference skipped: ${first.reason}`);
    return;
  }
  if (first.toolCalls.length === 0) {
    await input.host.recordTurn(input.agentId, first.content || "(empty thought)");
    return;
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
    const output = await executeLocalTool({ workspace: input.workspace, call, denyHosts: input.denyHosts });
    notes.push(`${call.name}: ${output}`);
  }
  const summary = notes.join("\n").slice(0, 1800);
  await input.host.recordTurn(input.agentId, summary || first.content || "Acted.");
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
