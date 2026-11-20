import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { fetchWithBackoff, rateLimitCounts, resetRateLimits } from "../src/http.js";
import { InferenceGateway } from "../src/inference.js";
import { OpenRouterLlm, type LlmClient, type ModelCatalog } from "../src/llm.js";
import type { ModelContextCache } from "../src/model-context.js";
import { parseUsd } from "../src/money.js";
import type { ChatMessage } from "../src/types.js";
import { harness } from "./helpers.js";

const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const PRIMARY = "org/heretic-normal";
const FB1 = "fallback/model-one";
const FB2 = "fallback/model-two";
const HOUR = 3_600_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  resetRateLimits();
});

interface Step {
  status: number;
  headers?: Record<string, string>;
  model?: string;
  cost?: number;
  promptTokens?: number;
  completionTokens?: number;
}

class ScriptedFetch {
  calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
  constructor(public plan: Step[]) {}
  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const text = typeof init?.body === "string" ? init.body : undefined;
    this.calls.push({ url: String(url), body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined });
    const step = this.plan.shift() ?? { status: 200 };
    if (step.status !== 200) return new Response("upstream says no", { status: step.status, headers: step.headers });
    return new Response(
      JSON.stringify({
        model: step.model,
        choices: [{ message: { content: "I will wait." } }],
        usage: { prompt_tokens: step.promptTokens ?? 100, completion_tokens: step.completionTokens ?? 50, cost: step.cost },
      }),
      { status: 200 },
    );
  };
  chat() {
    return this.calls.filter((call) => call.url === CHAT_URL);
  }
}

const TOOLS = [{ type: "function", function: { name: "balance", description: "", parameters: { type: "object", properties: {} } } }];

function llmFor(script: ScriptedFetch, config: ReturnType<typeof harness>["config"], contextLengths: Record<string, number> = {}) {
  const sleeps: number[] = [];
  const catalog = { supportedParameters: async () => ["tools"] } as unknown as ModelCatalog;
  const contexts = { contextLength: async (model: string) => contextLengths[model] ?? 1_000_000 } as unknown as ModelContextCache;
  const llm = new OpenRouterLlm(config, {
    fetch: script.fetch as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    catalog,
    contexts,
  });
  return { llm, sleeps };
}

function rig(overrides: Record<string, string> = {}) {
  const box = harness({ LLM_MODE: "openrouter", OPENROUTER_API_KEY: "test-key-0000", ...overrides });
  cleanups.push(box.cleanup);
  return box;
}

const ask = (llm: OpenRouterLlm, messages: ChatMessage[] = [{ role: "user", content: "hello" }]) =>
  llm.complete({ model: PRIMARY, messages, tools: TOOLS });

describe("backoff on 502, 503 and 429", () => {
  it("succeeds after a 503, waiting once", async () => {
    const box = rig();
    const script = new ScriptedFetch([{ status: 503 }, { status: 200, model: PRIMARY }]);
    const { llm, sleeps } = llmFor(script, box.config);
    const done = await ask(llm);
    expect(done.content).toBe("I will wait.");
    expect(script.chat()).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it("succeeds after a 502", async () => {
    const box = rig();
    const script = new ScriptedFetch([{ status: 502 }, { status: 200, model: PRIMARY }]);
    const { llm } = llmFor(script, box.config);
    expect((await ask(llm)).content).toBe("I will wait.");
    expect(script.chat()).toHaveLength(2);
  });

  it("honours retry-after on a 429", async () => {
    const box = rig();
    const script = new ScriptedFetch([{ status: 429, headers: { "retry-after": "3" } }, { status: 200, model: PRIMARY }]);
    const { llm, sleeps } = llmFor(script, box.config);
    await ask(llm);
    expect(sleeps).toEqual([3000]);
  });

  it("does not retry a 500 or a 400", async () => {
    for (const status of [500, 400]) {
      const box = rig();
      const script = new ScriptedFetch([{ status }, { status: 200, model: PRIMARY }]);
      const { llm, sleeps } = llmFor(script, box.config);
      await expect(ask(llm)).rejects.toThrow(`OpenRouter HTTP ${status}`);
      expect(script.chat()).toHaveLength(1);
      expect(sleeps).toHaveLength(0);
    }
  });

  it("stops after 4 attempts and returns the last failure", async () => {
    const calls: number[] = [];
    const response = await fetchWithBackoff("https://example.test/x", undefined, "openrouter", {
      fetch: (async () => {
        calls.push(1);
        return new Response("down", { status: 503 });
      }) as typeof fetch,
      sleep: async () => undefined,
    });
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(4);
  });

  it("retries 502 and 503 for search too, but not for the facilitator (settlement moves money)", async () => {
    for (const [source, status, expected] of [
      ["search", 503, 2],
      ["search", 502, 2],
      ["facilitator", 503, 1],
      ["facilitator", 502, 1],
      ["facilitator", 429, 2],
    ] as const) {
      const calls: number[] = [];
      const response = await fetchWithBackoff("https://example.test/x", undefined, source, {
        fetch: (async () => {
          calls.push(1);
          return calls.length === 1 ? new Response("no", { status }) : new Response("ok", { status: 200 });
        }) as typeof fetch,
        sleep: async () => undefined,
      });
      expect(calls, `${source} ${status}`).toHaveLength(expected);
      expect(response.status, `${source} ${status}`).toBe(expected === 2 ? 200 : status);
    }
  });

  it("counts a retried 429 for the report but not a retried 502 or 503", async () => {
    resetRateLimits();
    const sleep = async () => undefined;
    const once = (status: number) => {
      let n = 0;
      return (async () => (++n === 1 ? new Response("no", { status }) : new Response("ok"))) as typeof fetch;
    };
    await fetchWithBackoff("https://example.test/x", undefined, "openrouter", { fetch: once(503), sleep });
    await fetchWithBackoff("https://example.test/x", undefined, "openrouter", { fetch: once(502), sleep });
    expect(rateLimitCounts().openrouter).toBe(0);
    await fetchWithBackoff("https://example.test/x", undefined, "openrouter", { fetch: once(429), sleep });
    expect(rateLimitCounts().openrouter).toBe(1);
  });
});

describe("the models array in the request", () => {
  it("sends model and no models when no fallback is set", async () => {
    const box = rig();
    const script = new ScriptedFetch([{ status: 200, model: PRIMARY }]);
    await ask(llmFor(script, box.config).llm);
    const body = script.chat()[0]?.body ?? {};
    expect(body.model).toBe(PRIMARY);
    expect("models" in body).toBe(false);
  });

  it("sends models, primary first and without model, when fallbacks are set", async () => {
    const box = rig({ FALLBACK_MODELS: `${FB1},${FB2}` });
    const script = new ScriptedFetch([{ status: 200, model: PRIMARY }]);
    await ask(llmFor(script, box.config).llm);
    const body = script.chat()[0]?.body ?? {};
    expect(body.models).toEqual([PRIMARY, FB1, FB2]);
    expect("model" in body).toBe(false);
  });

  it("removes the primary from the fallbacks, and sends no models when nothing else is left", async () => {
    const withPrimary = rig({ FALLBACK_MODELS: `${PRIMARY},${FB1}` });
    const first = new ScriptedFetch([{ status: 200, model: PRIMARY }]);
    await ask(llmFor(first, withPrimary.config).llm);
    expect(first.chat()[0]?.body?.models).toEqual([PRIMARY, FB1]);
    const onlyPrimary = rig({ FALLBACK_MODELS: PRIMARY });
    const second = new ScriptedFetch([{ status: 200, model: PRIMARY }]);
    await ask(llmFor(second, onlyPrimary.config).llm);
    expect(second.chat()[0]?.body?.model).toBe(PRIMARY);
    expect("models" in (second.chat()[0]?.body ?? {})).toBe(false);
  });

  it("trims the messages to the smallest context among the primary and the fallbacks", async () => {
    const messages: ChatMessage[] = Array.from({ length: 30 }, (_, index) => ({ role: "user", content: `${"word ".repeat(400)}${index}` }));
    const plain = rig();
    const small = rig({ FALLBACK_MODELS: FB1 });
    const wide = new ScriptedFetch([{ status: 200, model: PRIMARY }]);
    const narrow = new ScriptedFetch([{ status: 200, model: PRIMARY }]);
    await ask(llmFor(wide, plain.config, { [PRIMARY]: 1_000_000, [FB1]: 3_000 }).llm, messages);
    await ask(llmFor(narrow, small.config, { [PRIMARY]: 1_000_000, [FB1]: 3_000 }).llm, messages);
    const count = (script: ScriptedFetch) => (script.chat()[0]?.body?.messages as unknown[]).length;
    expect(count(wide)).toBe(30);
    expect(count(narrow)).toBeLessThan(30);
  });
});

describe("FALLBACK_MODELS and MODEL_PRICES in the config", () => {
  const base = (extra: Record<string, string>) => ({
    DATA_DIR: os.tmpdir(),
    MONEY_MODE: "dry-run",
    NETWORK: "base-sepolia",
    WALLET_MASTER_KEY: "test-master-key-1234",
    ADMIN_TOKEN: "test-admin",
    TREASURY_ADDRESS: "0x1111111111111111111111111111111111111111",
    LLM_MODE: "mock",
    ...extra,
  });

  it("defaults to none", () => {
    expect(loadConfig(base({})).fallbackModels).toEqual([]);
    expect(loadConfig(base({})).modelPrices).toEqual({});
  });

  it("is trimmed and de-duplicated, and three entries are allowed", () => {
    expect(loadConfig(base({ FALLBACK_MODELS: " a/one , b/two ,a/one,, c/three" })).fallbackModels).toEqual(["a/one", "b/two", "c/three"]);
  });

  it("fails at load with more than three entries", () => {
    expect(() => loadConfig(base({ FALLBACK_MODELS: "a/one,b/two,c/three,d/four" }))).toThrow(/FALLBACK_MODELS/);
  });

  it("parses MODEL_PRICES and refuses a malformed one", () => {
    const priced = loadConfig(base({ MODEL_PRICES: JSON.stringify({ "a/one": { promptPerM: 0.5, completionPerM: 1.5 } }) }));
    expect(priced.modelPrices).toEqual({ "a/one": { promptPerM: 0.5, completionPerM: 1.5 } });
    for (const bad of ["not json", "[]", JSON.stringify({ "a/one": { promptPerM: -1, completionPerM: 1 } }), JSON.stringify({ "a/one": { promptPerM: 1 } })]) {
      expect(() => loadConfig(base({ MODEL_PRICES: bad })), bad).toThrow(/MODEL_PRICES/);
    }
  });
});

describe("a lost wake", () => {
  async function agentOn(box: ReturnType<typeof rig>, name = "maker") {
    const created = await box.swarm.createAgent({ name });
    if (!created.ok) throw new Error(created.error);
    box.swarm.ownerTopup(created.value.id, parseUsd("1"), `seed-${name}`);
    return created.value.id;
  }
  const messages: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
  const events = (box: ReturnType<typeof rig>, id: string, kind: string) =>
    box.db.prepare("SELECT message FROM events WHERE agent_id = ? AND kind = ?").all(id, kind) as unknown as Array<{ message: string }>;

  it("is recorded when every model fails, with nothing debited and no refusals row", async () => {
    const box = rig({ FALLBACK_MODELS: `${FB1},${FB2}` });
    const id = await agentOn(box);
    const script = new ScriptedFetch([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }]);
    const { llm, sleeps } = llmFor(script, box.config);
    const gateway = new InferenceGateway(box.swarm, llm, box.config);
    const before = box.swarm.snapshot(id).balanceUnits;
    const ledger = (box.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE agent_id = ?").get(id) as { n: number }).n;
    const result = await gateway.complete(id, messages, TOOLS);
    expect(result.skipped).toBe(true);
    if (result.skipped) expect(result.reason).toContain("503");
    expect(box.swarm.snapshot(id).balanceUnits).toBe(before);
    expect((box.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE agent_id = ?").get(id) as { n: number }).n).toBe(ledger);
    const lost = events(box, id, "lost_wake");
    expect(lost).toHaveLength(1);
    expect(lost[0]?.message).toContain(`model=${PRIMARY}`);
    expect(lost[0]?.message).toContain("503");
    expect(box.db.prepare("SELECT COUNT(*) AS n FROM refusals WHERE agent_id = ?").get(id)).toEqual({ n: 0 });
    expect(sleeps).toHaveLength(3);
  });

  it("is recorded for a non-retryable failure too", async () => {
    const box = rig();
    const id = await agentOn(box);
    const failing: LlmClient = {
      async complete() {
        throw new Error("OpenRouter HTTP 500: boom");
      },
    };
    const result = await new InferenceGateway(box.swarm, failing, box.config).complete(id, messages, TOOLS);
    expect(result.skipped).toBe(true);
    expect(events(box, id, "lost_wake")).toHaveLength(1);
  });

  it("is not recorded for a skip that is not a model failure", async () => {
    const box = rig();
    const id = await agentOn(box);
    const failing: LlmClient = {
      async complete() {
        throw new Error("should not be called");
      },
    };
    const gateway = new InferenceGateway(box.swarm, failing, box.config);
    await box.swarm.setKillSwitch(true);
    expect((await gateway.complete(id, messages, TOOLS)).skipped).toBe(true);
    await box.swarm.setKillSwitch(false);
    box.db.prepare("UPDATE agents SET balance_units = 0 WHERE id = ?").run(id);
    expect((await gateway.complete(id, messages, TOOLS)).skipped).toBe(true);
    expect(events(box, id, "lost_wake")).toHaveLength(0);
  });
});

describe("the served model", () => {
  async function agentOn(box: ReturnType<typeof rig>) {
    const created = await box.swarm.createAgent({ name: "maker" });
    if (!created.ok) throw new Error(created.error);
    box.swarm.ownerTopup(created.value.id, parseUsd("1"), "seed");
    return created.value.id;
  }
  const messages: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
  const turnModels = (box: ReturnType<typeof rig>, id: string) =>
    (box.db.prepare("SELECT model FROM turns WHERE agent_id = ? ORDER BY id").all(id) as unknown as Array<{ model: string | null }>).map((row) => row.model);

  it("is recorded on the turn, noted on the debit, and charged at the cost OpenRouter billed", async () => {
    const box = rig({ FALLBACK_MODELS: FB1 });
    const id = await agentOn(box);
    const script = new ScriptedFetch([{ status: 200, model: FB1, cost: 0.0005 }]);
    const gateway = new InferenceGateway(box.swarm, llmFor(script, box.config).llm, box.config);
    const before = box.swarm.snapshot(id).balanceUnits;
    const result = await gateway.complete(id, messages, TOOLS);
    expect(result.skipped).toBe(false);
    if (!result.skipped) expect(result.model).toBe(FB1);
    expect(before - box.swarm.snapshot(id).balanceUnits).toBe(500);
    const note = box.db.prepare("SELECT note FROM ledger_entries WHERE agent_id = ? AND kind = 'inference'").get(id) as { note: string };
    expect(note.note).toBe(FB1);
    box.swarm.recordTurn(id, "acted");
    box.swarm.recordTurn(id, "idle");
    expect(turnModels(box, id)).toEqual([FB1, null]);
  });

  it("uses the served model's price, not the requested model's, when OpenRouter returns no cost", async () => {
    const prices = {
      [PRIMARY]: { promptPerM: 0.15, completionPerM: 0.6 },
      [FB1]: { promptPerM: 0.075, completionPerM: 0.2 },
    };
    const box = rig({ FALLBACK_MODELS: FB1, MODEL_PRICES: JSON.stringify(prices), INFERENCE_RESERVE_USD: "0.05" });
    const id = await agentOn(box);
    const script = new ScriptedFetch([{ status: 200, model: FB1, promptTokens: 100_000, completionTokens: 50_000 }]);
    const gateway = new InferenceGateway(box.swarm, llmFor(script, box.config).llm, box.config);
    const before = box.swarm.snapshot(id).balanceUnits;
    await gateway.complete(id, messages, TOOLS);
    // 0.1M prompt tokens at $0.075 plus 0.05M completion tokens at $0.20 per million: $0.0175.
    expect(before - box.swarm.snapshot(id).balanceUnits).toBe(17_500);
  });

  it("falls back to the requested model when the response names none", async () => {
    const box = rig();
    const id = await agentOn(box);
    const script = new ScriptedFetch([{ status: 200, cost: 0.0002 }]);
    const result = await new InferenceGateway(box.swarm, llmFor(script, box.config).llm, box.config).complete(id, messages, TOOLS);
    if (!result.skipped) expect(result.model).toBe(PRIMARY);
  });
});

describe("the report and the migration", () => {
  const failing: LlmClient = {
    async complete() {
      throw new Error("OpenRouter HTTP 503: down");
    },
  };

  it("lists lost wakes per agent and turns per served model for the last day", async () => {
    const box = rig();
    const a = await box.swarm.createAgent({ name: "maker" });
    const b = await box.swarm.createAgent({ name: "other" });
    if (!a.ok || !b.ok) throw new Error("create failed");
    box.swarm.ownerTopup(a.value.id, parseUsd("1"), "seed-a");
    const gateway = new InferenceGateway(box.swarm, failing, box.config);
    await gateway.complete(a.value.id, [{ role: "user", content: "u" }], TOOLS);
    for (const [id, model] of [[a.value.id, "fallback/model-a"], [a.value.id, "fallback/model-a"], [b.value.id, "fallback/model-b"]] as const) {
      box.swarm.noteServedModel(id, model);
      box.swarm.recordTurn(id, "acted");
    }
    box.swarm.recordTurn(a.value.id, "Inference skipped: down");
    const { markdown } = box.swarm.writeDailyReport();
    const section = markdown.slice(markdown.indexOf("## Model reliability"));
    expect(markdown).toContain("## Model reliability");
    expect(section).toContain("- maker: 1");
    expect(section).not.toContain("- other: 1");
    expect(section).toContain("- fallback/model-a: 2");
    expect(section).toContain("- fallback/model-b: 1");
    box.clock.advance(25 * HOUR);
    const later = box.swarm.writeDailyReport().markdown;
    expect(later.slice(later.indexOf("## Model reliability"))).toContain("None in the last day.");
  });

  it("adds turns.model to a database made before this change, keeping every row, and is safe to run again", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-mig24-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "automaton.sqlite");
    const old = openDatabase(file);
    const cols = old.prepare("PRAGMA table_info(turns)").all() as unknown as { name: string }[];
    if (cols.some((col) => col.name === "model")) old.exec("ALTER TABLE turns DROP COLUMN model");
    old.prepare("INSERT INTO turns (agent_id, content, created_at) VALUES ('a1', 'an old turn', 5)").run();
    old.close();
    const fresh = openDatabase(file);
    expect(fresh.prepare("SELECT content, model FROM turns WHERE agent_id = 'a1'").get()).toEqual({ content: "an old turn", model: null });
    fresh.close();
    openDatabase(file).close();
  });
});

describe("the soak template and the source", () => {
  const MISTRAL = "mistralai/mistral-small-3.2-24b-instruct";
  const GEMINI = "google/gemini-2.5-flash-lite";

  function templateValues(): Record<string, string> {
    const file = fileURLToPath(new URL("../config/soak.env.template", import.meta.url));
    const values: Record<string, string> = {};
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (match) values[match[1] ?? ""] = match[2] ?? "";
    }
    return values;
  }

  it("sets FALLBACK_MODELS to Kevin's two models in his order, and the config parses them in that order", () => {
    const values = templateValues();
    expect(values.FALLBACK_MODELS).toBe(`${MISTRAL},${GEMINI}`);
    const config = loadConfig({
      DATA_DIR: os.tmpdir(),
      MONEY_MODE: "dry-run",
      NETWORK: "base-sepolia",
      WALLET_MASTER_KEY: "test-master-key-1234",
      ADMIN_TOKEN: "test-admin",
      TREASURY_ADDRESS: "0x1111111111111111111111111111111111111111",
      LLM_MODE: "mock",
      FALLBACK_MODELS: values.FALLBACK_MODELS ?? "",
      MODEL_PRICES: values.MODEL_PRICES ?? "",
    });
    expect(config.fallbackModels).toEqual([MISTRAL, GEMINI]);
    expect(config.modelPrices[MISTRAL]).toEqual({ promptPerM: 0.075, completionPerM: 0.2 });
    expect(config.modelPrices[GEMINI]).toEqual({ promptPerM: 0.1, completionPerM: 0.4 });
  });

  it("has no fallback model ID written in src", () => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
      });
    for (const file of walk(root)) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toContain("mistral-small-3.2");
      expect(text, file).not.toContain("gemini-2.5-flash-lite");
    }
  });
});
