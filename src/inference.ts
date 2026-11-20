import type { AppConfig, ModelPrice } from "./config.js";
import { costUnits, type LlmClient } from "./llm.js";
import { newId } from "./ids.js";
import { reviewText } from "./constitution.js";
import type { Swarm } from "./swarm.js";
import type { ChatMessage, Result, ToolCall } from "./types.js";

export class InferenceGateway {
  constructor(
    private readonly swarm: Swarm,
    private readonly llm: LlmClient,
    private readonly config: AppConfig,
  ) {}

  async complete(
    agentId: string,
    messages: ChatMessage[],
    tools: unknown[],
  ): Promise<
    | { skipped: true; reason: string }
    | { skipped: false; content: string; toolCalls: ToolCall[]; model: string; costUnits: number }
  > {
    const snapshot = this.swarm.snapshot(agentId);
    if (snapshot.killSwitch) return { skipped: true, reason: "Global kill switch is on." };
    if (snapshot.status !== "running") return { skipped: true, reason: `Status is ${snapshot.status}.` };
    if (snapshot.balanceUnits <= 0) return { skipped: true, reason: "Balance is not positive." };
    const ceiling = await this.authorizationCeiling(snapshot.model, tools);
    const allowed = this.swarm.authorize(agentId, ceiling, "inference");
    if (!allowed.ok) return { skipped: true, reason: allowed.error };
    let completion;
    try {
      completion = await this.llm.complete({ model: snapshot.model, messages, tools });
    } catch (error) {
      // Every model failed after backoff and fallback: a lost wake. Nothing is debited (a debit follows only a completed call).
      const reason = error instanceof Error ? error.message : "The model call failed.";
      this.swarm.recordLostWake(agentId, snapshot.model, reason);
      return { skipped: true, reason };
    }
    // The model that actually answered, which the turn will record and the cost is computed for.
    this.swarm.noteServedModel(agentId, completion.model);
    const actual = billable(completion.usage, completion.model, ceiling, this.config.modelPrices);
    const debited = this.swarm.debit(agentId, actual, "inference", `infer:${newId()}`, completion.model);
    if (!debited.ok) return { skipped: true, reason: debited.error };
    const toolCalls: ToolCall[] = completion.toolCalls.slice(0, 4).map((call) => ({
      id: call.id || newId("call"),
      name: call.name,
      arguments: parseArgs(call.arguments),
    }));
    return { skipped: false, content: completion.content ?? "", toolCalls, model: completion.model, costUnits: actual };
  }

  async council(agentId: string, question: string): Promise<Result<string>> {
    const review = reviewText(question);
    if (!review.allowed) return { ok: false, error: review.reason };
    const models = this.config.councilModels;
    if (models.length === 0) return { ok: false, error: "No council models are configured." };
    const snapshot = this.swarm.snapshot(agentId);
    const voiceCeilings: number[] = [];
    for (const model of models) voiceCeilings.push(await this.authorizationCeiling(model, []));
    const synthCeiling = await this.authorizationCeiling(snapshot.model, []);
    const reserve = this.config.councilFeeUnits + voiceCeilings.reduce((sum, item) => sum + item, 0) + synthCeiling;
    const allowed = this.swarm.authorize(agentId, reserve, "council");
    if (!allowed.ok) return allowed;
    const voices: string[] = [];
    let spent = this.config.councilFeeUnits;
    for (let index = 0; index < models.length; index += 1) {
      const model = models[index] ?? "";
      const ceiling = voiceCeilings[index] ?? synthCeiling;
      try {
        const reply = await this.llm.complete({
          model,
          messages: [
            { role: "system", content: "You are one voice on a small council advising an AI agent. Be concrete. Do not impersonate a human." },
            { role: "user", content: question },
          ],
        });
        voices.push(`${model}: ${reply.content}`);
        spent += billable(reply.usage, model, ceiling, this.config.modelPrices);
      } catch (error) {
        voices.push(`${model}: unavailable (${error instanceof Error ? error.message : "error"})`);
      }
    }
    let synthesis = voices.join("\n");
    try {
      const synth = await this.llm.complete({
        model: snapshot.model,
        messages: [
          { role: "system", content: "Synthesize the council into one short answer. You are an AI speaking to an AI." },
          { role: "user", content: `${question}\n\n${voices.join("\n")}` },
        ],
      });
      synthesis = synth.content || synthesis;
      spent += billable(synth.usage, snapshot.model, synthCeiling, this.config.modelPrices);
    } catch {
      synthesis = voices.join("\n");
    }
    const charge = Math.min(reserve, spent);
    const debited = this.swarm.debit(agentId, charge, "council", `council:${newId()}`, "council");
    if (!debited.ok) return debited;
    const checked = reviewText(synthesis);
    return {
      ok: true,
      value: checked.allowed ? synthesis : "The council answer was withheld because it broke the constitution.",
    };
  }

  /** A JSON turn can pay for a second call, so it is reserved at twice the single-call cap. */
  private async authorizationCeiling(model: string, tools: unknown[]): Promise<number> {
    const reserve = this.config.inferenceReserveUnits;
    let mayRetry = true;
    try {
      if (this.llm.mayRetry) mayRetry = await this.llm.mayRetry({ model, tools });
    } catch {
      mayRetry = true;
    }
    return mayRetry ? reserve * 2 : reserve;
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // The model returned plain text.
  }
  return {};
}

function safeCost(
  usage: { promptTokens: number; completionTokens: number; costUsd?: string },
  model: string,
  prices?: Record<string, ModelPrice>,
): number {
  try {
    return costUnits(usage, model, prices);
  } catch {
    return 1;
  }
}

function billable(
  usage: { promptTokens: number; completionTokens: number; costUsd?: string },
  model: string,
  ceiling: number,
  prices?: Record<string, ModelPrice>,
): number {
  return Math.min(ceiling, Math.max(1, safeCost(usage, model, prices)));
}
