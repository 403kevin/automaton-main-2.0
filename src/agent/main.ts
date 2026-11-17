import { HttpHost } from "./http-host.js";
import { runAgentLoop } from "./loop.js";

const agentId = process.env.AGENT_ID ?? "";
const token = process.env.AGENT_TOKEN ?? "";
const baseUrl = process.env.ORCHESTRATOR_URL ?? "";
const workspace = process.env.WORKSPACE ?? "/workspace";
const denyHosts = (process.env.OWNER_DENY_HOSTS ?? "").split(",").map((item) => item.trim()).filter(Boolean);

if (!agentId || !token || !baseUrl) {
  console.error("Agent body is missing AGENT_ID, AGENT_TOKEN, or ORCHESTRATOR_URL.");
  process.exit(1);
}

const host = new HttpHost(baseUrl, agentId, token);
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());

await runAgentLoop({
  agentId,
  host,
  signal: controller.signal,
  workspace,
  denyHosts,
  sleepMs: Number(process.env.TURN_INTERVAL_MS ?? 15_000),
});
