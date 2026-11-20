import type { InferenceGateway } from "./inference.js";
import type { AgentHost } from "./agent/loop.js";
import type { Swarm } from "./swarm.js";
import type { AgentSnapshot, ChatMessage, ToolCall } from "./types.js";

export class DirectHost implements AgentHost {
  constructor(
    private readonly swarm: Swarm,
    private readonly inference: InferenceGateway,
  ) {}

  snapshot(agentId: string): Promise<AgentSnapshot> {
    return Promise.resolve(this.swarm.snapshot(agentId));
  }

  infer(agentId: string, messages: ChatMessage[], tools: unknown[]) {
    return this.inference.complete(agentId, messages, tools);
  }

  authorizeTool(agentId: string, call: ToolCall) {
    return this.swarm.handleTool(agentId, call);
  }

  async recordTurn(agentId: string, text: string): Promise<void> {
    this.swarm.recordTurn(agentId, text);
  }

  async recordRefusal(agentId: string, tool: string, rule: string, reason: string): Promise<void> {
    this.swarm.recordAgentRefusal(agentId, tool, rule, reason);
  }
}
