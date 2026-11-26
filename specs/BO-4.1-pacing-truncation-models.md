# BO-4.1 — Budget pacing, truncation fix, ops cleanups, and Stage 4 model swap

Spec for ORDER BO-4.1. Format: `to-spec` (mattpocock/skills). Lives in `repo/specs/` so the PR can cite it (same reason as earlier Automaton specs).

## Problem Statement

Soak agents burn the whole `$0.25` daily cap in the first hour because containers ignore `TURN_INTERVAL_MS` (they fall back to 15s) and there is no hourly spend ceiling. Truncated model replies (`finish_reason=length` at a hard `700` token limit) still run half-parsed JSON actions. Stage 4 needs paid tool-calling models in both soak profiles, and two ops scripts need safer path quoting, a read-only preflight mode, and clean probe cleanup.

## Solution

Pass the configured turn interval into Docker agent containers. Add an optional per-agent hourly spend cap that, when set, blocks discretionary spend for the rest of the UTC hour and tells the agent loop how long to sleep until the next window. Raise and configure `max_tokens`, surface `finish_reason`, refuse truncated JSON actions, and count truncations in the Model reliability report. Swap soak model ids to the Stage 4 paid set. Fix `pull-reports.sh` usage quoting and add `preflight.sh --read-only` plus archive-or-note cleanup for `preflight-probe`.

## User Stories

1. As Kevin, I want agent containers to receive `TURN_INTERVAL_MS` from the orchestrator config, so a soak set to five minutes does not wake every fifteen seconds.
2. As Kevin, I want an optional `AGENT_HOURLY_CAP_USD` (default off), so existing unit tests keep their daily-only behaviour.
3. As Kevin, I want the soak profiles to set the hourly cap to `$0.04` and the example file to set it to `0`, so soak pacing is on and the profile-key tests stay green.
4. As Kevin, I want `checkSpend` to refuse discretionary spend for the rest of the UTC hour when the hourly cap would be exceeded, so agents cannot dump a day's budget in one hour.
5. As Kevin, I want a clear refusal message (and `spend.cap` or `spend.cap.hourly`) when the hourly ceiling blocks a spend, so the reason is obvious in logs and refusals.
6. As an agent loop, I want `retryAfterMs` on a skipped inference caused by a spend cap, so I sleep until the next UTC hour (hourly) or next UTC midnight (daily) instead of spinning empty skipped turns.
7. As Kevin, I want that long sleep to still wake on kill-switch / abort, so the swarm can stop promptly.
8. As Kevin, I want lost-wake accounting left unchanged, so Stage 3 exit numbers stay comparable.
9. As Kevin, I want `MAX_OUTPUT_TOKENS` (default 1500, minimum 256) instead of a hard-coded 700, so replies have room to finish.
10. As Kevin, I want that limit written in `.env.example` and both soak profiles, so owners can see and tune it.
11. As Kevin, I want OpenRouter's `finish_reason` exposed on completions, so truncation is visible to the runtime.
12. As Kevin, I want truncated JSON action fallbacks not executed when `finish_reason` is `length`, so half a tool call cannot run.
13. As Kevin, I want an `inference_truncated` event recorded when that happens, so the day can be audited.
14. As Kevin, I want the Model reliability section to print `Truncated (length): <count>` for the last 24 hours, so the daily report shows the rate.
15. As Kevin, I want both soak profiles on the Stage 4 paid model set (no `:free`), identical on every key except `MONEY_MODE`.
16. As Kevin, I want `SOAK_AGENT_MODELS` to name mite, keel, and wick each with their own paid model, and seeding to accept all three.
17. As Kevin, I want `pull-reports.sh` usage to show a quoted `"<local-dir>"` example, so paths with spaces are not split.
18. As Kevin, I want `preflight.sh --read-only` to run checks 1–4 and 6 without toggling the kill switch or creating a probe, so a live last-day check is safe.
19. As Kevin, I want check 5's cleanup to archive `preflight-probe` via the orchestrator or leave a clear cleanup note, so the ledger does not keep an unarchived probe.

## Implementation Decisions

**Docker turn interval.** `DockerRuntime.start` adds `-e TURN_INTERVAL_MS=${this.config.turnIntervalMs}` next to the other agent env flags. Process runtime already uses `config.turnIntervalMs` in `runAgentLoop`; only Docker was missing the env.

**Hourly cap config.** `AppConfig.agentHourlyCapUnits` from `AGENT_HOURLY_CAP_USD`, default `0` (disabled). Soak template and Sepolia profile set `0.04`. `.env.example` sets `0`.

**Hourly check.** `checkSpend` gains optional `agentHourlySpent` and `agentHourlyCap`. When `agentHourlyCap > 0` and the spend would exceed it, refuse with a clear hourly message and `rule: "spend.cap.hourly"` (added to the closed refusal list). Swarm sums spend rows for the agent with `created_at` in the current UTC hour (from the swarm clock) and passes that into both `authorize` and `debit` paths.

**Cap sleep.** Skipped inference from a spend cap includes `retryAfterMs`: ms until next UTC hour for hourly, next UTC midnight for daily. `AgentHost.infer` / `InferenceGateway.complete` carry that field. `runAgentLoop` sleeps `retryAfterMs` when present, else `sleepMs`, still abortable via `AbortSignal`. HttpHost needs no special case beyond typing — JSON already forwards the field. Lost wakes stay as today.

**Output tokens.** `AppConfig.maxOutputTokens` from `MAX_OUTPUT_TOKENS`, default 1500, minimum 256 (`atLeast`). `buildCompletionBody` takes `maxTokens` and writes `max_tokens`. `OpenRouterLlm` passes `config.maxOutputTokens`. `completionLimit` keeps reading the body (fallback only if absent).

**Truncation.** `LlmCompletion.finishReason?: string` from `choices[0].finish_reason`. When `finishReason === "length"`, the JSON actions path does not turn content into tool calls; the gateway records `inference_truncated` via swarm and returns the turn with empty tool calls (call is still billed). `modelReliabilityLines` prints `Truncated (length): <n>` under Model reliability for events in the window.

**Stage 4 models.** Both soak profiles get the exact model / price / allow-list / agent-model assignments from the order. Caps stay `AGENT_DAILY_CAP_USD=0.25`, `GLOBAL_DAILY_CAP_USD=0.60`, `TURN_INTERVAL_MS=300000`. `parseSoakAgentModels` already accepts mite, keel, and wick.

**Ops.** `pull-reports.sh` usage and header quote `"<local-dir>"`. `preflight.sh` gains `--read-only` (skip check 5). Check 5 cleanup calls an admin archive for the probe when possible, otherwise logs a cleanup note naming the probe id.

**No deploy.** Base Sepolia / `ALLOW_MAINNET=false` only. No secrets committed.

## Testing Decisions

Good tests assert external behaviour: env flags on a fake docker argv, cap refusals and `retryAfterMs`, truncated actions not executed, report line present, soak keys identical except money mode, seed parsing for three agents. Prefer existing seams (`checkSpend`, `loadConfig`, `DockerRuntime` with a stub docker binary, `OpenRouterLlm` with scripted fetch, `harness`, `parseSoakAgentModels`, file reads for scripts/profiles).

New file `test/bo-4-1.test.ts` covers hourly pacing, cap-sleep `retryAfterMs`, Docker `TURN_INTERVAL_MS`, `MAX_OUTPUT_TOKENS` / `finish_reason === "length"`, and `SOAK_AGENT_MODELS` for all three agents. Existing targeted files (`spend-caps`, `soak-profile-keys`, `compose-config`, `report-v2`, `model-reliability`, `runtime`) stay green; update the report fixture only if the new Truncated line changes the snapshot.

## Out of Scope

- Deploying or starting the Vultr host.
- Mainnet / `ALLOW_MAINNET=true`.
- Changing lost-wake semantics or Stage 3 exit thresholds.
- Full-suite runs beyond the targeted list in the order.
- Reworking rent, kill-switch, or non-discretionary spend to use the hourly cap.

## Further Notes

- Hourly cap default `0` is intentional so `test/spend-caps.test.ts` and other daily-only harnesses need no change unless they opt in.
- Model ids and prices are Kevin/Grok Stage 4 choices recorded in the order; this spec does not invent substitutes.
