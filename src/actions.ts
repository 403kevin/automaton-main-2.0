import type { ChatMessage, ToolCall } from "./types.js";

export type ModelProtocol = "tools" | "json";

/** Native tools only when the provider says this model accepts them. Unknown models use JSON. */
export function protocolFor(supportedParameters: string[] | undefined): ModelProtocol {
  return supportedParameters?.includes("tools") ? "tools" : "json";
}

export function supportsJsonObject(supportedParameters: string[] | undefined): boolean {
  if (!supportedParameters) return false;
  return supportedParameters.includes("response_format") || supportedParameters.includes("json_object");
}

export function jsonInstruction(tools: unknown[]): string {
  const lines = tools.map((tool) => {
    const record = tool as { function?: { name?: string; description?: string } };
    const name = record.function?.name ?? "tool";
    const description = record.function?.description ?? "";
    return `- ${name}: ${description}`;
  });
  return [
    "Reply with one JSON object and no other text.",
    'Shape: {"say":"short note. You are an AI.","actions":[{"name":"tool_name","arguments":{}}]}',
    "actions may be an empty array when you are only speaking.",
    "Tools:",
    ...lines,
  ].join("\n");
}

export function buildCompletionBody(input: {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  supported?: string[];
}): { protocol: ModelProtocol; body: Record<string, unknown> } {
  const tools = input.tools ?? [];
  const protocol = protocolFor(input.supported);
  if (protocol === "tools" && tools.length > 0) {
    return {
      protocol,
      body: {
        model: input.model,
        messages: input.messages,
        tools,
        tool_choice: "auto",
        max_tokens: 700,
      },
    };
  }
  const messages: ChatMessage[] = [{ role: "system", content: jsonInstruction(tools) }, ...input.messages];
  const body: Record<string, unknown> = { model: input.model, messages, max_tokens: 700 };
  if (supportsJsonObject(input.supported)) body.response_format = { type: "json_object" };
  return { protocol: "json", body };
}

export function extractActions(text: string):
  | { ok: true; say: string; actions: { name: string; arguments: Record<string, unknown> }[] }
  | { ok: false; error: string } {
  const candidate = unwrapJson(text);
  if (!candidate) return { ok: false, error: "No JSON object in the model reply." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, error: "Model reply was not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "JSON reply must be an object." };
  }
  const record = parsed as Record<string, unknown>;
  const say = typeof record.say === "string" ? record.say : "";
  if (Array.isArray(record.actions)) {
    const actions = record.actions.map(readAction).filter((item): item is { name: string; arguments: Record<string, unknown> } => item !== undefined);
    return { ok: true, say, actions };
  }
  const single = readAction(record);
  if (single) return { ok: true, say, actions: [single] };
  return { ok: true, say: say || candidate, actions: [] };
}

export function toolCallsFromActions(actions: { name: string; arguments: Record<string, unknown> }[]): ToolCall[] {
  return actions.map((action, index) => ({
    id: `json-${index}-${action.name}`,
    name: action.name,
    arguments: action.arguments,
  }));
}

function readAction(value: unknown): { name: string; arguments: Record<string, unknown> } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : typeof record.tool === "string" ? record.tool : "";
  if (!name) return undefined;
  const raw = record.arguments ?? record.args ?? {};
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { name, arguments: args };
}

function unwrapJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  if (body.startsWith("{") && body.endsWith("}")) return body;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) return body.slice(start, end + 1);
  return undefined;
}
