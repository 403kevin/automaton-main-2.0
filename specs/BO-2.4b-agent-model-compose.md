# BO-2.4b — per-agent model choice, and every config variable reaches the container

Spec for ORDER BO-2.4b (section 35 of `AUTOMATON_COLLAB_FOR_GROK.md`). It follows [BO-2.4](BO-2.4-model-reliability.md) and carries three things from the PR #9 review: Kevin's decisions of 2026-11-20 (Dolphin is out; one lower-guardrail, tool-capable model for a single soak agent, still to be chosen), the compose-forwarding gap, and the council-pricing fix.
Format: `to-spec` (mattpocock/skills). It lives in `repo/specs/` for the same reason as the earlier specs: `spec-artifact` points at Omega's `20-CONTROL/specs/`, which is outside this git repo and could not be cited from the PR.
Nothing here steers what an agent does. A model is plumbing; the constitution, the tripwires, the refusal rules and the spend caps do not look at which model an agent runs on.

## Problem Statement

The database already lets each agent have its own model (`agents.model`, `low_model`, `critical_model`; `modelFor` picks by tier; `spawn_child` copies the parent's three values), but nothing governs it: any string is accepted, the owner has no way to change an agent's model without touching the database, the dashboard and report do not show which model an agent was given beside which ones actually served it, and the soak seeding has no way to give one agent a different model. Kevin has also decided that Dolphin is out (it has no tool calling) and wants one soak agent on a lower-guardrail model that does support tools. Separately, the review found that docker-compose forwards only the variables it names, so most price and limit settings never reach the container on the plain path; and council voices are priced by the model that was asked for, not the one that answered.

## Solution

An allowlist of models (`ALLOWED_MODELS`, defaulting to every model the config already names) that every per-agent model must be on; an owner-only admin route to change an agent's models; the assigned model shown on the dashboard and in the report beside the served counts; an optional per-agent model in the soak seeding, with the slot for Kevin's choice left empty and commented out; a proof that the same guards apply to every model; compose changes that make every variable in the env files reach the orchestrator, pinned by a test; and council voices priced by the served model. The Dolphin defaults are replaced everywhere they would still be used.

## User Stories

1. As Kevin, I want an agent's model restricted to a list I control, so that a typo or a hostile value cannot send an agent to an arbitrary model.
2. As Kevin, I want to change an agent's models with my admin token and no agent tool or agent route able to do it, so that an agent can never pick its own model.
3. As Kevin, I want a child to start with its parent's models and to be unaffected by later changes to the parent, so that inheritance stays simple.
4. As Kevin, I want an agent whose stored model is no longer on the list to fall back to the global model at start-up, with an event, so that a changed list cannot strand an agent.
5. As Kevin, I want the soak seeding to accept one model per named agent, refused if it is off the list, with the slot empty until I fill it.
6. As Kevin, I want the dashboard and the daily report to show the assigned model beside the models that served its turns, so that I can see a mismatch at a glance.
7. As Kevin, I want proof that the constitution, tripwires, refusal rules and spend caps behave identically for an agent on a non-default model, so that choosing a lighter model does not lower the guards.
8. As Kevin, I want every variable in the soak template and `.env.example` to reach the orchestrator on both compose paths, and a test that fails on a variable the app does not read, so that a template value is never silently ignored.
9. As Kevin, I want no secret to have a default in a compose file.
10. As Kevin, I want council voices charged at the price of the model that answered.
11. As Kevin, I want Dolphin gone from every file the soak would load, and no model ID written in `src`.

## Implementation Decisions

**`ALLOWED_MODELS`.** A comma-separated config list, trimmed, empty entries dropped, de-duplicated. **Unset, it defaults to the union of the configured default, low-compute, critical, council and fallback models**, so an existing setup keeps working with no change. When set, it is used exactly as written. Every per-agent `model`, `low_model` and `critical_model` must be on it (a null means "use the global model" and is always valid, because the global models are checked by being configured, not by being listed). Enforced in three places: `Swarm.createAgent` (which `spawn_child` and the admin create route also use), the new admin route, and the seed path; each refuses with the reason "Model <id> is not on the allowed models list." At start-up, any live agent whose stored model, low model or critical model is not on the list has that value cleared to the global model, with an `agent_model_reset` event naming the value.

**The admin route.** `POST /admin/agents/<id>/model`, behind the existing `ADMIN_TOKEN` check (header `X-Admin-Token`). The body may carry `model`, `lowModel` and `criticalModel`: an omitted key is unchanged, `null` clears it to the global model, a string must be on the list; anything else, or an empty body, is a 400; an unknown or archived agent is refused. It writes an `agent_model_changed` event naming the three resulting values and answers with them. **No agent tool and no `/internal/agents/*` route can change a model**: the tool list has none, an unknown tool is refused, and the internal route pattern does not include it; tests pin all three.

**Inheritance, unchanged.** A child is created with the parent's three values at spawn. A later admin change to the parent does not touch existing children (tested).

**Seeding.** The seed code moves from `src/cli.ts` to `src/seed.ts` (`seedLocal`, `seedHttp`) so it can be tested; `cli.ts` calls it. The soak agents are `mite`, `keel` and `wick` (`SOAK_SEEDS` in `src/soak.ts`; seeded by `runSoak` in `src/cli.ts`, directly through `Swarm.createAgent` when the orchestrator is down, or through `POST /admin/agents` when it is up). A new optional `SOAK_AGENT_MODELS` is `name=model id` pairs separated by commas; a name that is not a seed agent, a repeated name or an empty model is an error; a model off the allowlist is refused by `createAgent`, and all the models are checked before the first agent is created. **A seeded model applies to all three tiers** (`model`, `low_model` and `critical_model`), so an agent chosen to run on one model does not silently change model when it drops to the low-compute or critical tier. **Kevin's slot:** the template carries `# SOAK_AGENT_MODELS=<<KEVIN: one agent name = one tool-capable model id; Grok suggests mistralai/mistral-nemo>>`, commented out so the template parses, and says to add the model to `ALLOWED_MODELS` when it is filled. Nothing is filled in. `ALLOWED_MODELS` itself is not set in the template (the default already covers the configured models).

**Dolphin out.** `DEFAULT_MODEL`, `LOW_COMPUTE_MODEL`, `CRITICAL_MODEL` and `COUNCIL_MODELS` become `mistralai/mistral-small-3.2-24b-instruct` in `config/soak.env.template`, **and in `config/soak.sepolia.env`**: that is the profile the `soak` command defaults to and the one `docker-compose.soak.yml` loads, so leaving Dolphin there would keep Dolphin running. The `SOAK_MODEL` constant (a Dolphin ID written in `src`) is removed, and the soak test that compared against it now reads the new default; the README paragraph about Dolphin is replaced. `MODEL_PRICES` in the template gains `mistralai/mistral-nemo` at $0.029 in and $0.03 out per million tokens, read from https://openrouter.ai/api/v1/models on 2026-11-20 at 13:06 CST.

**Display.** The overview gives each agent an `assigned` block (the normal, low-compute and critical models, each the agent's own or the global one). The dashboard card shows it next to the current model. The report's "## Model reliability" gains "### Assigned and served": one line per agent, `- <name>: assigned <model> -> served <model> <n>, <model> <n>` (or `served none`), where assigned is the normal-tier model and served counts the turns of the last 24 hours by `turns.model`. Names and models are sanitised.

**The same guards for every model.** No code path branches on a model ID for the constitution, the refusals, the tripwires, the spend caps or any tool check. Two tests pin it: a scan that the guard modules (`tripwires`, `spend`, `refusals`, `claims`, `predictions`, `verify-offer`, `payer`) never mention a model, and the one place the constitution does ("language model", in a deception pattern) is a text pattern, not a branch; and a behavioural test that runs the same refusal cases (a constitution-blocked claim, a private-address URL, an over-cap spend, a symlink write) for an agent on the default model and an agent on a non-default allowlisted model, each through the inference gateway with a fake model client, and gets identical rule IDs. The same test checks that the model the agent was assigned is the one the client is asked for.

**Compose forwarding.** `docker-compose.safe.yml`: the `.env.soak` `env_file` entry becomes `required: true`. `docker-compose.yml`: the orchestrator gains `env_file: [{ path: .env, required: false }]`, so the plain path also receives every variable in `.env`. Variables named under `environment:` still win. **No secret gets a default:** the base file's dev defaults for `WALLET_MASTER_KEY` and `ADMIN_TOKEN` (`dev-only-master-key-change-me`, `dev-admin-token-change-me`) become empty (`${X:-}`), which the app already handles (it generates a master key into the data volume and an admin token it prints once). `TREASURY_ADDRESS` is a public address, not a secret, and keeps its dummy default; the safe file still requires all three with `:?`. `test/compose-config.test.ts` parses, with no new dependency, every `env.X` name read in `src/config.ts` and asserts each one reaches the orchestrator through an `env_file` on the documented paths or is named in `environment:`; it asserts that no compose file gives a secret (a name ending `KEY`, `TOKEN` or `SECRET`) a non-empty default; and it asserts that every key in `config/soak.env.template` and `.env.example` is a name the app reads (`src/config.ts`, plus `src/soak.ts` and the CLI for the seeding variables), which catches typos. Any name legitimately read elsewhere is listed in the test with its reason.

**Council pricing.** Each council voice and the synthesis are billed by the model the completion says answered (the completion's `model`, falling back to the requested one), through `costUnits(usage, model, config.modelPrices)`.

**No new dependencies. No model ID in `src`. Mock mode only.**

## Testing Decisions

- Seams: `Swarm.createAgent` and the admin route (through `startServer`); `Swarm` construction for the start-up normalisation; `seedLocal`/`seedHttp` and the `SOAK_AGENT_MODELS` parser; `InferenceGateway` with a fake client for the guards and the council; `overview`, the dashboard HTML and `writeDailyReport`; static parsing of compose files, `config.ts` and the env files.
- Cases: the allowlist at `createAgent`, the admin route and seeding; inheritance; the admin route with and without the token and no way for an agent to change a model; the report and dashboard; identical rule IDs on a non-default model; the compose and config pinning including the typo check; a council voice served by a fallback priced at the fallback's price; the template parses, has no Dolphin and keeps the seeding slot commented out; the start-up normalisation; every existing test.
- Prior art: `test/refusals.test.ts`, `test/model-reliability.test.ts`, `test/soak.test.ts`, `test/hands.test.ts` (the server with a token).

## Out of Scope

- Choosing the lower-guardrail model (Kevin's decision); a per-tier allowlist; letting an agent request a model change.
- A live check of any model's behaviour (the Stage 3 preflight).
- Forwarding variables on any path other than the two named; changing how the tier picks a model.

## Further Notes

- "Lightly moderated" is a reputation, not something measured; the constitution and every guard stay on regardless of the model.
- The default allowlist is deliberately permissive so that nothing breaks; an owner who wants it tight sets `ALLOWED_MODELS`.
