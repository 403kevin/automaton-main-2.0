import type { AgentSnapshot, ChatMessage, ToolCall } from "../types.js";
import type { AgentHost } from "./loop.js";

export class HttpHost implements AgentHost {
  constructor(
    private readonly baseUrl: string,
    private readonly agentId: string,
    private readonly token: string,
  ) {}

  async snapshot(): Promise<AgentSnapshot> {
    return this.request("GET", "/snapshot") as Promise<AgentSnapshot>;
  }

  async infer(agentId: string, messages: ChatMessage[], tools: unknown[]) {
    void agentId;
    return this.request("POST", "/infer", { messages, tools }) as ReturnType<AgentHost["infer"]>;
  }

  async authorizeTool(agentId: string, call: ToolCall) {
    void agentId;
    return this.request("POST", "/tool", { call }) as ReturnType<AgentHost["authorizeTool"]>;
  }

  async recordTurn(agentId: string, text: string): Promise<void> {
    void agentId;
    await this.request("POST", "/turn", { text });
  }

  private async request(method: string, suffix: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/internal/agents/${this.agentId}${suffix}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    if (!response.ok) {
      const error = typeof parsed === "object" && parsed && "error" in parsed ? String((parsed as { error: string }).error) : text;
      throw new Error(error || `HTTP ${response.status}`);
    }
    return parsed;
  }
}
