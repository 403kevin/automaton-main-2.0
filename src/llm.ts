import type { AppConfig } from "./config.js";
import { parseUsd } from "./money.js";
import type { ChatMessage } from "./types.js";

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd?: string;
}

export interface LlmCompletion {
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage: LlmUsage;
  model: string;
}

export interface LlmClient {
  complete(input: { model: string; messages: ChatMessage[]; tools?: unknown[] }): Promise<LlmCompletion>;
}

const PRICES: Record<string, { promptPerM: number; completionPerM: number }> = {
  default: { promptPerM: 0.15, completionPerM: 0.6 },
};

export function costUnits(usage: LlmUsage, model: string): number {
  if (usage.costUsd) return Math.max(1, parseUsd(usage.costUsd));
  const price = PRICES[model] ?? PRICES.default;
  const dollars =
    (usage.promptTokens / 1_000_000) * price.promptPerM + (usage.completionTokens / 1_000_000) * price.completionPerM;
  return Math.max(1, Math.round(dollars * 1_000_000));
}

export class MockLlm implements LlmClient {
  async complete(input: { model: string }): Promise<LlmCompletion> {
    return {
      model: input.model,
      content:
        "I am an AI agent. I will look for work someone voluntarily pays for, and I will not invent income. Conserving compute until a payer appears.",
      toolCalls: [],
      usage: { promptTokens: 120, completionTokens: 40, costUsd: "0.0001" },
    };
  }
}

export class OpenRouterLlm implements LlmClient {
  constructor(private readonly config: AppConfig) {}

  async complete(input: { model: string; messages: ChatMessage[]; tools?: unknown[] }): Promise<LlmCompletion> {
    const response = await fetch(this.config.openRouterUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.openRouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:4747",
        "X-Title": "Automaton",
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        tools: input.tools && input.tools.length > 0 ? input.tools : undefined,
        max_tokens: 700,
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenRouter HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const body = JSON.parse(text) as {
      choices?: { message?: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const message = body.choices?.[0]?.message;
    const cost = body.usage?.cost;
    return {
      model: input.model,
      content: message?.content ?? "",
      toolCalls: (message?.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
        costUsd: typeof cost === "number" ? cost.toFixed(6) : undefined,
      },
    };
  }
}

export function createLlm(config: AppConfig): LlmClient {
  return config.llmMode === "openrouter" ? new OpenRouterLlm(config) : new MockLlm();
}
