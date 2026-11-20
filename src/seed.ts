import { notAllowedModel } from "./config.js";
import { parseUsd } from "./money.js";
import { redact } from "./redact.js";
import { SOAK_SEEDS } from "./soak.js";
import type { Swarm } from "./swarm.js";

/** Soak agent name -> the one model id that agent runs on, for every tier. */
export type SeedModels = Readonly<Record<string, string>>;

/**
 * SOAK_AGENT_MODELS is `name=model id` pairs separated by commas (specs/BO-2.4b-agent-model-compose.md). Unset or empty means no
 * agent has its own model. A name that is not a soak agent, a name given twice and an empty model are errors, so a typo cannot
 * quietly leave an agent on the default model.
 */
export function parseSoakAgentModels(raw: string | undefined): Record<string, string> {
  const models: Record<string, string> = {};
  const known = new Set<string>(SOAK_SEEDS.map((seed) => seed.name));
  for (const item of (raw ?? "").split(",")) {
    const entry = item.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    const name = (eq < 0 ? entry : entry.slice(0, eq)).trim();
    const model = eq < 0 ? "" : entry.slice(eq + 1).trim();
    if (!model) throw new Error(`SOAK_AGENT_MODELS entry for "${name}" must be name=model id.`);
    if (!known.has(name)) throw new Error(`SOAK_AGENT_MODELS names "${name}", which is not a soak agent (${[...known].join(", ")}).`);
    if (name in models) throw new Error(`SOAK_AGENT_MODELS names "${name}" twice.`);
    models[name] = model;
  }
  return models;
}

function agentModels(model: string | undefined): { model?: string; lowModel?: string; criticalModel?: string } {
  return model ? { model, lowModel: model, criticalModel: model } : {};
}

export async function seedLocal(swarm: Swarm, usd: string, models: SeedModels = {}): Promise<void> {
  for (const model of Object.values(models)) {
    if (!swarm.modelAllowed(model)) throw new Error(notAllowedModel(model));
  }
  for (const seed of SOAK_SEEDS) {
    const existing = swarm.overview().agents.find((agent) => agent.name === seed.name && agent.status !== "archived");
    if (existing) {
      console.log(`${seed.name} is already ${existing.status} (${existing.id}).`);
      continue;
    }
    const created = await swarm.createAgent({ name: seed.name, genesisPrompt: seed.genesis, ...agentModels(models[seed.name]) });
    if (!created.ok) throw new Error(created.error);
    const topped = swarm.ownerTopup(created.value.id, parseUsd(usd), `soak-seed-${seed.name}`);
    if (!topped.ok) throw new Error(topped.error);
    console.log(`Seeded ${seed.name} ${created.value.id} at ${created.value.address} with $${usd}.`);
  }
}

export async function seedHttp(base: string, token: string, usd: string, models: SeedModels = {}): Promise<void> {
  const overview = (await authed(base, token, "GET", "/api/overview")) as { agents: { id: string; name: string; status: string }[] };
  for (const seed of SOAK_SEEDS) {
    const existing = overview.agents.find((agent) => agent.name === seed.name && agent.status !== "archived");
    if (existing) {
      console.log(`${seed.name} is already ${existing.status} (${existing.id}).`);
      continue;
    }
    const chosen = models[seed.name];
    const created = (await authed(base, token, "POST", "/admin/agents", {
      name: seed.name,
      genesisPrompt: seed.genesis,
      ...(chosen ? { model: chosen, lowModel: chosen, criticalModel: chosen } : {}),
    })) as { id: string; address: string };
    await authed(base, token, "POST", "/admin/topup", { agentId: created.id, usd, ref: `soak-seed-${seed.name}` });
    console.log(`Seeded ${seed.name} ${created.id} at ${created.address} with $${usd}.`);
  }
}

async function authed(base: string, token: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Admin-Token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(redact(payload.error || `HTTP ${response.status}`));
  return payload;
}
