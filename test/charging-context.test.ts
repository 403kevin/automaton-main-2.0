import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { CONSTITUTION_TEXT } from "../src/constitution.js";
import { InferenceGateway } from "../src/inference.js";
import { OpenRouterLlm } from "../src/llm.js";
import {
  CONTEXT_CACHE_TTL_MS,
  estimateMessagesTokens,
  ModelContextCache,
  OPENROUTER_MODELS_URL,
} from "../src/model-context.js";
import { loadConfig } from "../src/config.js";
import { parseUsd } from "../src/money.js";
import { buildSystemPrompt } from "../src/prompt.js";
import type { AgentSnapshot, ChatMessage } from "../src/types.js";
import type { Swarm } from "../src/swarm.js";
import { harness } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const TOOLS = [{ type: "function", function: { name: "balance", description: "Read the ledger.", parameters: {} } }];
const VALID = '{"say":"I am an AI.","actions":[]}';

interface Reply {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
}

describe("retry charging", () => {
  it("debits the summed provider cost for a JSON retry and releases the unused authorization", async () => {
    const turn = await runTurn({
      name: "retryusd",
      model: "org/json-retry",
      topup: "5",
      supported: ["response_format"],
      replies: [
        { content: "I will just talk.", cost: 0.015 },
        { content: VALID, cost: 0.015 },
      ],
    });
    cleanups.push(turn.rig.cleanup);
    const reserve = turn.reserve;
    const debited = turn.before - turn.after;

    expect(turn.chats).toHaveLength(2);
    expect(turn.authorized).toEqual([reserve * 2]);
    expect(turn.result.skipped).toBe(false);
    if (turn.result.skipped) return;
    expect(debited).toBe(30_000);
    expect(debited).toBeGreaterThan(reserve);
    expect(debited).toBeLessThanOrEqual(reserve * 2);
    expect(turn.result.costUnits).toBe(debited);
    expect(reserve * 2 - debited).toBe(10_000);
    expect(inferenceCharges(turn.rig.db, turn.id)).toEqual({ rows: 1, units: debited });
    expect(spendUnits(turn.rig.db, turn.id)).toBe(debited);
  });

  it("debits the price-table sum when OpenRouter omits usage.cost", async () => {
    const turn = await runTurn({
      name: "retrytable",
      model: "org/json-table",
      topup: "5",
      supported: ["temperature"],
      replies: [
        { content: "still not json", promptTokens: 100_000, completionTokens: 0 },
        { content: VALID, promptTokens: 100_000, completionTokens: 0 },
      ],
    });
    cleanups.push(turn.rig.cleanup);
    const debited = turn.before - turn.after;
    expect(turn.chats).toHaveLength(2);
    expect(turn.authorized).toEqual([turn.reserve * 2]);
    expect(debited).toBe(30_000);
    expect(debited).toBeGreaterThan(turn.reserve);
    expect(debited).toBeLessThan(turn.reserve * 2);
    expect(inferenceCharges(turn.rig.db, turn.id).units).toBe(debited);
  });

  it("caps a retry turn at two reserves when the summed cost is higher", async () => {
    const turn = await runTurn({
      name: "retrycap",
      model: "org/json-cap",
      topup: "5",
      supported: ["response_format"],
      replies: [
        { content: "nope", cost: 0.05 },
        { content: VALID, cost: 0.05 },
      ],
    });
    cleanups.push(turn.rig.cleanup);
    const debited = turn.before - turn.after;
    expect(debited).toBe(turn.reserve * 2);
    expect(inferenceCharges(turn.rig.db, turn.id)).toEqual({ rows: 1, units: turn.reserve * 2 });
  });

  it("debits the first call when the retry request fails", async () => {
    const turn = await runTurn({
      name: "retryhalf",
      model: "org/json-half",
      topup: "5",
      supported: ["response_format"],
      failSecond: true,
      replies: [{ content: "not json", cost: 0.015 }],
    });
    cleanups.push(turn.rig.cleanup);
    const debited = turn.before - turn.after;
    expect(turn.chats).toHaveLength(2);
    expect(turn.authorized).toEqual([turn.reserve * 2]);
    expect(turn.result.skipped).toBe(false);
    expect(debited).toBe(15_000);
    expect(debited).toBeLessThan(turn.reserve * 2);
    expect(inferenceCharges(turn.rig.db, turn.id)).toEqual({ rows: 1, units: debited });
  });

  it("releases the whole pre-authorization when the paid call fails", async () => {
    const turn = await runTurn({
      name: "retryfail",
      model: "org/json-fail",
      topup: "5",
      supported: ["response_format"],
      failChat: true,
    });
    cleanups.push(turn.rig.cleanup);
    expect(turn.authorized).toEqual([turn.reserve * 2]);
    expect(turn.result.skipped).toBe(true);
    expect(turn.after).toBe(turn.before);
    expect(inferenceCharges(turn.rig.db, turn.id)).toEqual({ rows: 0, units: 0 });
    expect(turn.chats).toHaveLength(0);
  });

  it("refuses a retry turn that cannot cover two reserves before calling the model", async () => {
    const turn = await runTurn({
      name: "retryshort",
      model: "org/json-short",
      topup: "0.03",
      supported: ["response_format"],
      replies: [
        { content: "nope", cost: 0.015 },
        { content: VALID, cost: 0.015 },
      ],
    });
    cleanups.push(turn.rig.cleanup);
    expect(turn.reserve * 2).toBeGreaterThan(parseUsd("0.03"));
    expect(turn.authorized).toEqual([turn.reserve * 2]);
    expect(turn.result.skipped).toBe(true);
    if (!turn.result.skipped) return;
    expect(turn.result.reason).toMatch(/balance/i);
    expect(turn.chats).toHaveLength(0);
    expect(turn.after).toBe(turn.before);
  });

  it("pre-authorizes one reserve when the model will not retry", async () => {
    const turn = await runTurn({
      name: "toolsone",
      model: "org/tools-model",
      topup: "5",
      supported: ["tools", "response_format"],
      replies: [{ content: "Using the tool.", cost: 0.005 }],
    });
    cleanups.push(turn.rig.cleanup);
    const debited = turn.before - turn.after;
    expect(turn.chats).toHaveLength(1);
    expect(turn.authorized).toEqual([turn.reserve]);
    expect(debited).toBe(5_000);
    expect(debited).toBeLessThan(turn.reserve);
    expect(inferenceCharges(turn.rig.db, turn.id).units).toBe(debited);
  });
});

describe("context window", () => {
  it("trims a 200k-token history for a 128k model and keeps the system prompt", async () => {
    const model = "org/long-context";
    const system = systemPrompt(model);
    const history: ChatMessage[] = [];
    for (let index = 0; index < 200; index += 1) {
      history.push({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${"x".repeat(4000)} <<HISTORY-${index}>>`,
      });
    }
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: CONSTITUTION_TEXT },
      ...history,
    ];
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(200_000);

    const chats: { messages: ChatMessage[]; max_tokens?: number }[] = [];
    const llm = new OpenRouterLlm(openRouterConfig(), {
      fetch: modelsThenChat(model, 128_000, ["response_format"], chats),
      sleep: async () => undefined,
    });
    await llm.complete({ model, messages, tools: TOOLS });

    expect(chats).toHaveLength(1);
    const sent = chats[0]?.messages ?? [];
    const maxTokens = chats[0]?.max_tokens ?? 0;
    expect(maxTokens).toBe(700);
    expect(estimateMessagesTokens(sent) + maxTokens).toBeLessThanOrEqual(128_000);
    expect(sent.some((message) => message.content === system)).toBe(true);
    expect(sent.some((message) => message.content === CONSTITUTION_TEXT)).toBe(true);
    const flat = JSON.stringify(sent);
    expect(flat).not.toContain("<<HISTORY-0>>");
    expect(flat).toContain("<<HISTORY-199>>");
    expect(flat).toContain("autonomous AI agent");
  });

  it("uses a 32000 context when the models list cannot be fetched", async () => {
    const model = "org/fallback-context";
    const system = systemPrompt(model);
    const small = "s".repeat(20_000 * 4);
    const big = `${"b".repeat(40_000 * 4)} TOO-BIG`;
    const chats: { messages: ChatMessage[]; max_tokens?: number }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/models")) throw new Error("models list down");
      const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[]; max_tokens?: number };
      chats.push(body);
      return jsonResponse({
        choices: [{ message: { content: VALID } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0001 },
      });
    };
    const llm = new OpenRouterLlm(openRouterConfig(), { fetch: fetchImpl, sleep: async () => undefined });
    const base: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: CONSTITUTION_TEXT },
    ];

    await llm.complete({ model, messages: [...base, { role: "user", content: small }], tools: TOOLS });
    await llm.complete({ model, messages: [...base, { role: "user", content: big }], tools: TOOLS });

    const kept = chats[0]?.messages ?? [];
    const trimmed = chats[1]?.messages ?? [];
    expect(chats[0]?.max_tokens).toBe(700);
    expect(kept.some((message) => message.content === small)).toBe(true);
    expect(estimateMessagesTokens(kept) + 700).toBeLessThanOrEqual(32_000);
    expect(trimmed.some((message) => message.content === system)).toBe(true);
    expect(trimmed.some((message) => message.content === CONSTITUTION_TEXT)).toBe(true);
    expect(JSON.stringify(trimmed)).not.toContain("TOO-BIG");
    expect(estimateMessagesTokens(trimmed) + 700).toBeLessThanOrEqual(32_000);
    expect(estimateMessagesTokens([...base, { role: "user", content: big }]) + 700).toBeGreaterThan(32_000);
  });

  it("caches context length for 24 hours and falls back to 32000", async () => {
    let calls = 0;
    let fail = false;
    let now = 1_000;
    let sawAuth = false;
    const cache = new ModelContextCache(async (input, init) => {
      calls += 1;
      expect(String(input)).toBe(OPENROUTER_MODELS_URL);
      const headers = new Headers(init?.headers);
      if (headers.has("authorization") || headers.has("Authorization")) sawAuth = true;
      if (fail) return new Response("no", { status: 503 });
      return jsonResponse({
        data: [
          { id: "org/model", context_length: 128000 },
          { id: "org/other", context_length: 8192 },
        ],
      });
    }, () => now);

    expect(await cache.contextLength("org/model")).toBe(128000);
    expect(await cache.contextLength("missing/model")).toBe(32000);
    expect(calls).toBe(1);
    expect(sawAuth).toBe(false);

    now += CONTEXT_CACHE_TTL_MS - 1;
    fail = true;
    expect(await cache.contextLength("org/model")).toBe(128000);
    expect(calls).toBe(1);

    now += 2;
    expect(await cache.contextLength("org/model")).toBe(32000);
    expect(calls).toBe(2);

    fail = false;
    expect(await cache.contextLength("org/other")).toBe(8192);
    expect(calls).toBe(3);

    const thrown = new ModelContextCache(async () => {
      throw new Error("network down");
    });
    expect(await thrown.contextLength("org/model")).toBe(32000);
  });
});

function systemPrompt(model: string): string {
  const snapshot: AgentSnapshot = {
    id: "a0000000000000001",
    name: "keeper",
    status: "running",
    tier: "normal",
    model,
    balanceUnits: 5_000_000,
    balance: "$5.00",
    genesisPrompt: "Decide how to earn.",
    strategyNotes: "",
    killSwitch: false,
    walletAddress: "0x1111111111111111111111111111111111111111",
    rentUnits: 500_000,
    graceUntil: null,
    recentTurns: [],
  };
  return buildSystemPrompt(snapshot);
}

function openRouterConfig() {
  return loadConfig({
    DATA_DIR: "/tmp/automaton-context-test",
    MONEY_MODE: "dry-run",
    NETWORK: "base-sepolia",
    WALLET_MASTER_KEY: "test-master-key-1234",
    LLM_MODE: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
    INFERENCE_RESERVE_USD: "0.02",
  });
}

async function runTurn(options: {
  name: string;
  model: string;
  topup: string;
  supported: string[];
  replies?: Reply[];
  failChat?: boolean;
  failSecond?: boolean;
  context?: number;
}) {
  const rig = harness({
    LLM_MODE: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
    INFERENCE_RESERVE_USD: "0.02",
    // Per-agent models are gated by ALLOWED_MODELS (BO-2.4b); this test assigns its own model to the agent.
    ALLOWED_MODELS: `org/heretic-normal,org/heretic-low,org/heretic-critical,${options.model}`,
    AGENT_DAILY_CAP_USD: "10",
    GLOBAL_DAILY_CAP_USD: "10",
  });
  const created = await rig.swarm.createAgent({
    name: options.name,
    model: options.model,
    lowModel: options.model,
    criticalModel: options.model,
  });
  if (!created.ok) throw new Error(created.error);
  const funded = rig.swarm.ownerTopup(created.value.id, parseUsd(options.topup), "seed");
  if (!funded.ok) throw new Error(funded.error);
  const chats: { messages?: ChatMessage[]; max_tokens?: number }[] = [];
  const llm = new OpenRouterLlm(rig.config, {
    fetch: modelsThenChat(
      options.model,
      options.context ?? 128_000,
      options.supported,
      chats,
      options.replies,
      options.failChat,
      options.failSecond,
    ),
    sleep: async () => undefined,
  });
  const authorized: number[] = [];
  const original = rig.swarm.authorize.bind(rig.swarm);
  rig.swarm.authorize = ((agentId: string, units: number, category: Parameters<Swarm["authorize"]>[2]) => {
    authorized.push(units);
    return original(agentId, units, category);
  }) as Swarm["authorize"];
  const gateway = new InferenceGateway(rig.swarm, llm, rig.config);
  const before = rig.swarm.snapshot(created.value.id).balanceUnits;
  const result = await gateway.complete(
    created.value.id,
    [
      { role: "system", content: "You are keeper, an autonomous AI agent." },
      { role: "user", content: "Your turn." },
    ],
    TOOLS,
  );
  const after = rig.swarm.snapshot(created.value.id).balanceUnits;
  return { rig, id: created.value.id, chats, authorized, before, after, result, reserve: rig.config.inferenceReserveUnits };
}

function modelsThenChat(
  model: string,
  contextLength: number,
  supported: string[],
  chats: { messages?: ChatMessage[]; max_tokens?: number }[],
  replies: Reply[] = [{ content: VALID }],
  failChat = false,
  failSecond = false,
): typeof fetch {
  let replyIndex = 0;
  return async (input, init) => {
    const url = String(input);
    if (url.includes("/models")) {
      return jsonResponse({
        data: [{ id: model, context_length: contextLength, supported_parameters: supported }],
      });
    }
    if (failChat) return new Response("upstream down", { status: 500 });
    chats.push(JSON.parse(String(init?.body)) as { messages?: ChatMessage[]; max_tokens?: number });
    const next = replies[Math.min(replyIndex, replies.length - 1)];
    const attempt = replyIndex;
    replyIndex += 1;
    if (failSecond && attempt === 1) return new Response("upstream down", { status: 500 });
    const usage: Record<string, number> = {
      prompt_tokens: next?.promptTokens ?? 10,
      completion_tokens: next?.completionTokens ?? 5,
    };
    if (typeof next?.cost === "number") usage.cost = next.cost;
    return jsonResponse({
      choices: [{ message: { content: next?.content ?? VALID } }],
      usage,
    });
  };
}

function inferenceCharges(db: DatabaseSync, agentId: string): { rows: number; units: number } {
  const rows = db
    .prepare("SELECT amount_units FROM ledger_entries WHERE agent_id = ? AND kind = 'inference'")
    .all(agentId) as unknown as { amount_units: number }[];
  return { rows: rows.length, units: rows.reduce((sum, row) => sum + -row.amount_units, 0) };
}

function spendUnits(db: DatabaseSync, agentId: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(amount_units), 0) AS n FROM spend WHERE agent_id = ?").get(agentId) as unknown as {
    n: number;
  };
  return row.n;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
