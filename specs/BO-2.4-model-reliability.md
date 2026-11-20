# BO-2.4 — model fallback, backoff on 502/503/429, lost wakes (+ facts round trip)

Spec for ORDER BO-2.4 (section 33 of `AUTOMATON_COLLAB_FOR_GROK.md`), plan row BO-2.4: a `FALLBACK_MODELS` list (at most 3) sent to OpenRouter, backoff on 502, 503 and 429, and a report of lost wakes and of which model actually served each turn. Acceptance: a mocked 503 then 200 succeeds; a mocked all-fail gives `lost_wake` with no debit; the report counts lost wakes and which model served each turn. Also carries over ruling (c) from the BO-2.7 review: a round-trip test that drives the real fact writers. Follows [BO-2.7](BO-2.7-predict-settlement.md).
Follow-up: [BO-2.4b](BO-2.4b-agent-model-compose.md) adds the per-agent model allowlist and admin route, removes Dolphin from the soak profiles, prices council voices by the served model, and makes every config variable reach the container.
Format: `to-spec` (mattpocock/skills). It lives in `repo/specs/` for the same reason as the earlier specs: `spec-artifact` points at Omega's `20-CONTROL/specs/`, which is outside this git repo and could not be cited from the PR.
The fallback list is plumbing, not steering: it decides which model answers when the primary cannot, never what an agent does.

## Problem Statement

A turn is one paid model call. Today a single 502 or 503 from OpenRouter, or an upstream provider that is down, ends the turn: the agent loses its wake, the loop writes "Inference skipped: OpenRouter HTTP 503", and nothing records that it happened or which model was tried. `fetchWithBackoff` retries only 429. There is no way to name a second model to try, and the report says nothing about how reliable the models were. Separately, BO-2.7 settles predictions by reading the text of facts the runtime writes, and the tests for that use fixture facts, so a change to a writer's format would silently turn every settlement into zero.

## Solution

`FALLBACK_MODELS` names up to three models. When it is set, each model request carries OpenRouter's `models` array (the agent's primary model first, then the fallbacks) so OpenRouter itself tries the next model when one fails. The HTTP client also retries 502 and 503 (as well as 429) for the calls that are safe to retry. The response says which model actually served the turn; that model, not the requested one, is what the turn records and what the cost is computed for. When every model fails the turn records a `lost_wake` event with the reason, and nothing is debited. The daily report counts lost wakes per agent and turns per served model. A round-trip test drives the real fact writers and checks them against the settlement parsers.

## User Stories

1. As Kevin, I want a second and third model tried when the primary fails, so that an agent does not lose a wake to one provider's outage.
2. As Kevin, I want the fallback list in config and never hard-coded in `src`, so that I choose the models and can change them without a code change.
3. As Kevin, I want a list longer than three refused when the app starts, so that a typo cannot send an open-ended list to OpenRouter.
4. As Kevin, I want a 502, 503 or 429 retried with backoff and a 500 or 4xx not retried, so that transient failures heal and real errors surface.
5. As Kevin, I want money-moving calls never retried on a 502 or 503, so that a gateway error cannot double a settlement.
6. As Kevin, I want each turn to record the model that actually answered, and to be charged at that model's price, so that the books match what was used.
7. As Kevin, I want a turn where every model failed to be recorded as a lost wake with a reason, with nothing debited and no refusal row, so that an outage is counted and is not mistaken for a refusal.
8. As Kevin, I want the report to show lost wakes per agent and turns per served model, so that I can see how reliable each model was.
9. As Kevin, I want the context trimmed to fit the smallest model in the list, so that a fallback with a smaller window does not fail on a prompt the primary accepted.
10. As Kevin, I want the soak template to carry my two chosen fallback models in my order, so that the soak runs with them.
11. As Kevin, I want a test that drives the real fact writers and the settlement parsers, so that a format change fails a test instead of zeroing settlements.

## Implementation Decisions

**`FALLBACK_MODELS`.** A comma-separated list in the environment. It is trimmed, empty entries are dropped, and duplicates are removed (order kept). **More than 3 entries after that fails at config load.** The default is empty, which means no fallback. The primary model is removed from the list per request, not at load, because the primary differs by tier (default, low-compute, critical) and by agent. The effective list for one request is the primary followed by the fallbacks that are not the primary; if no fallback is left, the request is exactly what it is today. OpenRouter's page states no maximum for `models`; the cap of three fallbacks is this project's own (the plan's), and the page's only stated cap of three is for a different parameter.

**The request shape.** When there is at least one effective fallback, the completion body carries `models: [primary, ...fallbacks]` and **omits `model`**; otherwise it carries `model` and no `models`, as today. Source: OpenRouter, "Model Fallbacks", https://openrouter.ai/docs/guides/routing/model-fallbacks, read 2026-11-20. What that page says, and what it does not:
- It says: "Provide an array of model IDs in priority order. If the first model returns an error, OpenRouter will automatically try the next model in the list." Its direct (`cURL` and fetch) examples send `models` alone; one SDK example sends `model` together with `models`, and says that the `model` value is tried first and the `models` array in order as fallbacks.
- It says any error can trigger a fallback ("including" context length errors, moderation flags, rate limiting and downtime), and that if the last fallback also fails OpenRouter returns that error.
- It says requests are priced at the model that was ultimately used, "returned in the `model` attribute of the response body". Whether a failed attempt is billed is not stated.
- **Not stated on that page, so not assumed here:** that the chat completions endpoint accepts `models` (its examples use `/api/v1/responses`); a maximum length for `models`; anything about 429, 502 or 503 and retrying; the `usage.cost` field; and how `tools` interact with fallback models. This project sends `models` to the chat completions endpoint as the order directs. If the endpoint rejects it, the call fails with a 400, which is not retried and becomes a lost wake: safe (nothing is debited), and loud. Confirming the live behaviour with one real call belongs in the Stage 3 preflight.

**Backoff.** `fetchWithBackoff` retries a 429 (as today), a 502 and a 503: at most 4 attempts in all, the delay starting at 1 second and doubling to a 30 second ceiling, and a `retry-after` header honoured (at most 60 seconds) for any of the three. A 500 and any other 4xx are not retried. **The 502 and 503 retries apply to the `openrouter` and `search` sources only; the `facilitator` source (the x402 settlement call) stays 429-only.** Settlement moves money, and a gateway error does not prove it did not go through; the standing rule is that a paid call is never retried blindly. A retried 429 is still counted for the report's "HTTP 429" line; a retried 502 or 503 is logged but not added to that count.

**The served model, and its price.** The completion's `model` is the response body's `model` string when present, else the requested primary. The turn is charged for that model: the cost is `usage.cost` when OpenRouter returns it (its billed cost for the model that served), else the served model's entry in `MODEL_PRICES`, else the existing default price. `MODEL_PRICES` is a new optional JSON setting (model id to `{ promptPerM, completionPerM }`, both numbers of 0 or more); a malformed value fails at config load; the default is empty. The debit note already carries the model, so the ledger shows the served model.

**Recording the served model on the turn.** A nullable `turns.model` column, added by an idempotent migration. The inference gateway tells the swarm which model served an agent's wake (`noteServedModel`); the next `recordTurn` for that agent stores it and clears it, so the model is the orchestrator's own knowledge and not something the agent's container reports. A turn with no model call (idle, skipped, lost) stores null.

**Lost wake.** When the model call throws after backoff and fallback, `InferenceGateway.complete` records a `lost_wake` event (`model=<primary> reason=<reason, at most 200 characters>`) and returns the skip it returns today ("Inference skipped: …" becomes the turn text). Nothing is debited: a debit happens only after a completed call, so the reserve is never taken. It writes no `refusals` row (it is not a tool call). Only a failed model call is a lost wake: a kill switch, an inactive agent, a non-positive balance and a failed authorization are skips and are not counted.

**Context fit.** The messages are trimmed to the smallest context length among the primary and the effective fallbacks (an unknown model uses the existing 32,000 default).

**Report.** `writeDailyReport` gains "## Model reliability" for the last 24 hours: "Lost wakes" (per agent, from `lost_wake` events) and "Turns per served model" (from `turns.model`, not counting turns with none). Model names are sanitised. With nothing, "None in the last day."

**Config and the soak template.** `FALLBACK_MODELS` and `MODEL_PRICES` in `config.ts` (default: empty) and `.env.example`. `config/soak.env.template` sets, per Kevin's decision of 2026-11-20, `FALLBACK_MODELS=mistralai/mistral-small-3.2-24b-instruct,google/gemini-2.5-flash-lite` in that order (Mistral first, because it is cheaper), and `MODEL_PRICES` with the prices read live from OpenRouter's models list at 11:10 MST that day: Mistral $0.075 in and $0.20 out per million tokens, Gemini $0.10 and $0.40. **No model ID is written in `src`**; a test scans `src` for the two.

**Carry-over: the facts round trip.** The two parse patterns in `predictions.ts` (credit values, the passing and any delivery value) are exported so a test can use them. A new test drives the real writers with no fixture facts: an outside `x402_in` credit and a sibling `x402_in` credit through the dry-run payment path, an outside `onchain_income` credit, a passing and a failing `serve_endpoint` test through a fake verifier, and an `ok` sense call; it asserts `computeActual` counts each for the right metrics, that predictions on those metrics settle to the right actual, and that **every** `credit` and `test_delivery` fact the writers produced (including `owner_topup` and `replication_in`) matches the patterns.

**No new dependencies. Mock mode only: no key, no network in tests.**

## Testing Decisions

- Seams: `fetchWithBackoff` with an injected fetch and sleep; `OpenRouterLlm` with an injected fetch (the posted body is captured); `InferenceGateway` with a real `Swarm` and a fake or real-OpenRouter client over a fake fetch; `loadConfig`; `writeDailyReport`; `openDatabase`. No network.
- Cases: 503 then 200 and 502 then 200 succeed; a 429 with `retry-after` is honoured; a 500 and a 400 are not retried; the cap is 4 attempts; the facilitator source is not retried on 502 or 503 but is on 429; all-fail gives a `lost_wake` with the balance unchanged and no refusals row, and the other skips are not lost wakes; the served model is recorded on the turn and its price is used (with `usage.cost`, and with `MODEL_PRICES`); `FALLBACK_MODELS` over three fails at load, is trimmed and de-duplicated, and an empty default means none; `models` is present only when fallbacks are set, primary first, without `model`, and with the primary removed from the fallbacks; the context is trimmed to the smallest model; the report; the migration; the soak template and the `src` scan; and the round trip.
- Prior art: `test/outside-money.test.ts` and `test/x402-v2.test.ts` (injected fetch and sleep), `test/hands.test.ts` (dry-run payments), `test/predictions.test.ts`, `test/refusals.test.ts` (report and migration).

## Out of Scope

- Choosing models, or steering an agent by model; a circuit breaker; retrying a paid outbound call on a gateway error.
- A live call to OpenRouter to confirm the `models` parameter on the chat completions endpoint (the Stage 3 preflight).
- Per-agent model lists, or changing how the tier picks the primary model.
- Report v2 (BO-2.5), which builds on the counts added here.

## Further Notes

- OpenRouter may bill a failed attempt, or a request that completed upstream before a 502 or 503 reached us; the docs read for this order do not say. The retry on 502 and 503 therefore carries a small risk of OpenRouter charging the orchestrator's account twice for one agent turn, while the agent's ledger is debited once. The reserve and the daily caps bound it.
- The fallback models must support the `tools` the turn sends; the page does not say what OpenRouter does otherwise. Kevin's two chosen models list tool support in OpenRouter's catalog.
