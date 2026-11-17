import { buildCompletionBody, extractActions, toolCallsFromActions } from "./actions.js";
import type { AppConfig } from "./config.js";
import { fetchWithBackoff } from "./http.js";
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

export class ModelCatalog {
  private loadedAt = 0;
  private loaded = false;
  private readonly parameters = new Map<string, string[]>();

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async supportedParameters(model: string): Promise<string[] | undefined> {
    if (!this.loaded || Date.now() - this.loadedAt > 600_000) await this.refresh();
    if (!this.loaded) return undefined;
    return this.parameters.get(model);
  }

  private async refresh(): Promise<void> {
    try {
      const response = await fetchWithBackoff("https://openrouter.ai/api/v1/models", undefined, "openrouter", {
        fetch: this.fetcher,
        sleep: this.sleep,
      });
      if (!response.ok) return;
      const body = (await response.json()) as { data?: { id?: string; supported_parameters?: string[] }[] };
      this.parameters.clear();
      for (const model of body.data ?? []) {
        if (model.id) this.parameters.set(model.id, model.supported_parameters ?? []);
      }
      this.loaded = true;
      this.loadedAt = Date.now();
    } catch {
      this.loaded = false;
    }
  }
}

export class OpenRouterLlm implements LlmClient {
  private readonly catalog: ModelCatalog;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly config: AppConfig,
    deps?: { fetch?: typeof fetch; catalog?: ModelCatalog; sleep?: (ms: number) => Promise<void> },
  ) {
    this.fetcher = deps?.fetch ?? fetch;
    this.sleep = deps?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.catalog = deps?.catalog ?? new ModelCatalog(this.fetcher, this.sleep);
  }

  async complete(input: { model: string; messages: ChatMessage[]; tools?: unknown[] }): Promise<LlmCompletion> {
    const supported = await this.catalog.supportedParameters(input.model);
    const planned = buildCompletionBody({ model: input.model, messages: input.messages, tools: input.tools, supported });
    const first = await this.post(planned.body);
    if (planned.protocol === "tools") return first;
    const parsed = extractActions(first.content);
    if (parsed.ok) {
      return { ...first, content: parsed.say || first.content, toolCalls: jsonToolCalls(parsed.actions) };
    }
    const retryMessages = [
      ...((planned.body.messages as ChatMessage[]) ?? input.messages),
      { role: "user" as const, content: "That was not valid JSON. Reply with one JSON object only, using say and actions." },
    ];
    const second = await this.post({ ...planned.body, messages: retryMessages });
    const again = extractActions(second.content);
    return {
      ...second,
      content: again.ok ? again.say || second.content : second.content,
      toolCalls: again.ok ? jsonToolCalls(again.actions) : [],
      usage: addUsage(first.usage, second.usage),
    };
  }

  private async post(body: Record<string, unknown>): Promise<LlmCompletion> {
    const response = await fetchWithBackoff(
      this.config.openRouterUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.openRouterKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:4747",
          "X-Title": "Automaton",
        },
        body: JSON.stringify(body),
      },
      "openrouter",
      { fetch: this.fetcher, sleep: this.sleep },
    );
    const text = await response.text();
    if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}: ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text) as {
      choices?: { message?: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const message = parsed.choices?.[0]?.message;
    const cost = parsed.usage?.cost;
    return {
      model: String(body.model ?? ""),
      content: message?.content ?? "",
      toolCalls: (message?.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      usage: {
        promptTokens: parsed.usage?.prompt_tokens ?? 0,
        completionTokens: parsed.usage?.completion_tokens ?? 0,
        costUsd: typeof cost === "number" ? cost.toFixed(6) : undefined,
      },
    };
  }
}

function jsonToolCalls(actions: { name: string; arguments: Record<string, unknown> }[]): LlmCompletion["toolCalls"] {
  return toolCallsFromActions(actions).map((call) => ({
    id: call.id,
    name: call.name,
    arguments: JSON.stringify(call.arguments),
  }));
}

function addUsage(left: LlmUsage, right: LlmUsage): LlmUsage {
  const cost = [left.costUsd, right.costUsd].filter(Boolean).map((item) => Number(item));
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    costUsd: cost.length ? cost.reduce((sum, item) => sum + item, 0).toFixed(6) : undefined,
  };
}

export function createLlm(config: AppConfig): LlmClient {
  return config.llmMode === "openrouter" ? new OpenRouterLlm(config) : new MockLlm();
}
