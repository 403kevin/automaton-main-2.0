import { CONSTITUTION_TEXT } from "./constitution.js";
import type { ChatMessage } from "./types.js";

/** Public OpenRouter catalog. No API key. */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export const CONTEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Used when the models list cannot be fetched, or does not name the model. */
export const FALLBACK_CONTEXT_TOKENS = 32_000;

interface ModelRow {
  id?: string;
  context_length?: number;
}

export class ModelContextCache {
  private fetchedAt = 0;
  private haveList = false;
  private readonly byId = new Map<string, number>();

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async contextLength(model: string): Promise<number> {
    if (!this.fresh()) await this.refresh();
    if (!this.fresh()) return FALLBACK_CONTEXT_TOKENS;
    return this.byId.get(model) ?? FALLBACK_CONTEXT_TOKENS;
  }

  private fresh(): boolean {
    return this.haveList && this.now() - this.fetchedAt < CONTEXT_CACHE_TTL_MS;
  }

  private async refresh(): Promise<void> {
    try {
      const response = await this.fetcher(OPENROUTER_MODELS_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return;
      const body = (await response.json()) as { data?: ModelRow[] };
      const rows = Array.isArray(body.data) ? body.data : [];
      this.byId.clear();
      for (const row of rows) {
        const length = typeof row.context_length === "number" ? row.context_length : Number.NaN;
        if (!row.id || !Number.isFinite(length) || length <= 0) continue;
        this.byId.set(row.id, Math.floor(length));
      }
      this.haveList = true;
      this.fetchedAt = this.now();
    } catch {
      // Leave any unexpired list in place. An expired or empty cache falls back to 32000.
    }
  }
}

export function estimateMessageTokens(message: ChatMessage): number {
  const chunks = [message.role, message.content ?? "", message.name ?? "", message.tool_call_id ?? ""];
  for (const call of message.tool_calls ?? []) {
    chunks.push(call.id, call.function?.name ?? "", call.function?.arguments ?? "");
  }
  const chars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return Math.ceil(chars / 4);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/**
 * Drop the oldest conversation messages until the prompt plus maxTokens fits.
 * System prompts and the identity/constitution block are never removed.
 */
export function trimMessagesToFit(messages: ChatMessage[], contextLength: number, maxTokens: number): ChatMessage[] {
  const limit = Number.isFinite(contextLength) && contextLength > 0 ? contextLength : FALLBACK_CONTEXT_TOKENS;
  const completion = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 0;
  const budget = Math.floor(limit) - completion;
  const costs = messages.map((message) => estimateMessageTokens(message));
  let total = costs.reduce((sum, cost) => sum + cost, 0);
  if (total <= budget) return messages;
  const drop = new Set<number>();
  for (let index = 0; index < messages.length && total > budget; index += 1) {
    const message = messages[index];
    if (!message || isPinnedMessage(message)) continue;
    drop.add(index);
    total -= costs[index] ?? 0;
  }
  if (drop.size === 0) return messages;
  return messages.filter((_, index) => !drop.has(index));
}

function isPinnedMessage(message: ChatMessage): boolean {
  if (message.role === "system") return true;
  const content = message.content ?? "";
  if (!content) return false;
  if (content.includes(CONSTITUTION_TEXT)) return true;
  return content.includes("autonomous AI agent") && content.includes("Constitution:");
}
