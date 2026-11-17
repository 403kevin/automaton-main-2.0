import { describe, expect, it } from "vitest";
import { buildCompletionBody, extractActions, protocolFor } from "../src/actions.js";
import { OpenRouterLlm } from "../src/llm.js";
import { loadConfig } from "../src/config.js";

const DOLPHIN = "cognitivecomputations/dolphin-mistral-24b-venice-edition";

describe("JSON actions for models without tools", () => {
  it("uses native tools only when supported_parameters includes tools", () => {
    expect(protocolFor(undefined)).toBe("json");
    expect(protocolFor(["response_format", "temperature"])).toBe("json");
    expect(protocolFor(["tools", "response_format"])).toBe("tools");
  });

  it("omits tools and asks for JSON when the model cannot call tools", () => {
    const planned = buildCompletionBody({
      model: DOLPHIN,
      messages: [{ role: "user", content: "Your turn." }],
      tools: [{ type: "function", function: { name: "balance", description: "Read the ledger.", parameters: {} } }],
      supported: ["response_format", "temperature"],
    });
    expect(planned.protocol).toBe("json");
    expect(planned.body.tools).toBeUndefined();
    expect(planned.body.tool_choice).toBeUndefined();
    expect(planned.body.response_format).toEqual({ type: "json_object" });
    const native = buildCompletionBody({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Your turn." }],
      tools: [{ type: "function", function: { name: "balance", description: "Read the ledger.", parameters: {} } }],
      supported: ["tools"],
    });
    expect(native.protocol).toBe("tools");
    expect(native.body.tool_choice).toBe("auto");
    expect(Array.isArray(native.body.tools)).toBe(true);
  });

  it("extracts a JSON action from prose and retries a mocked non-tool model", async () => {
    const embedded = extractActions('Sure.\n```json\n{"say":"I am an AI.","actions":[{"name":"web_search","arguments":{"query":"paid work"}}]}\n```');
    expect(embedded.ok && embedded.actions[0]?.name).toBe("web_search");
    expect(extractActions("not json at all").ok).toBe(false);

    const requests: unknown[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/models")) {
        return jsonResponse({
          data: [{ id: DOLPHIN, supported_parameters: ["response_format", "temperature", "max_tokens"] }],
        });
      }
      requests.push(JSON.parse(String(init?.body)));
      const content = requests.length === 1 ? "I will just talk." : '{"say":"I am an AI.","actions":[{"name":"balance","arguments":{}}]}';
      return jsonResponse({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 },
      });
    };
    const config = loadConfig({
      WALLET_MASTER_KEY: "test-master-key-1234",
      LLM_MODE: "openrouter",
      OPENROUTER_API_KEY: "sk-or-test",
      NETWORK: "base-sepolia",
      MONEY_MODE: "dry-run",
    });
    const llm = new OpenRouterLlm(config, { fetch: fetchImpl, sleep: async () => undefined });
    const result = await llm.complete({
      model: DOLPHIN,
      messages: [{ role: "user", content: "Your turn." }],
      tools: [{ type: "function", function: { name: "balance", description: "Read the ledger.", parameters: {} } }],
    });
    expect(requests).toHaveLength(2);
    for (const body of requests) {
      const record = body as { tools?: unknown; response_format?: { type: string } };
      expect(record.tools).toBeUndefined();
      expect(record.response_format).toEqual({ type: "json_object" });
    }
    expect(result.toolCalls.map((call) => call.name)).toEqual(["balance"]);
    expect(result.content).toContain("AI");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
