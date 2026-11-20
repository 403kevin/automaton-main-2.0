# BO-2.3 — refusal records (+ PR #6 carry-over)

Spec for ORDER BO-2.3 (section 29 of `AUTOMATON_COLLAB_FOR_GROK.md`), plan row BO-2.3: "Each refusal row has a rule ID and a reason; the report lists the counts by rule." It also carries over four items from the PR #6 review: a constitution-blocked claim logs `constitution_block`; the sample query is stored and used by the re-test; free gate attempts are capped per hour; the app wiring gets a test. Follows [BO-2.2](BO-2.2-no-phantom-products.md).
Follow-up: [BO-2.7](BO-2.7-predict-settlement.md) adds four rule IDs (`predict.shape`, `predict.open_cap`, `predict.tripwire`, `limit.hourly.predict`) and makes the offer gates check the fee before any sandbox run or URL check, closing the free "pass, then refused for balance" path noted under Gaps in the BO-2.3 report.
Format: `to-spec` (mattpocock/skills). It lives in `repo/specs/` for the same reason as the earlier specs: `spec-artifact` points at Omega's `20-CONTROL/specs/`, which is outside this git repo and could not be cited from the PR.
Nothing here judges or steers what an agent sells. It only records refusals and caps free attempts.

## Problem Statement

The runtime refuses a lot: kill switch, status, the constitution, spend caps, hourly limits, bad claims, failed offer tests, dead links, senses errors. Each refusal is a free-text event or a line in a turn note, with no rule ID, so nobody can ask "which rule refused this agent most today?" Refusals that happen in the agent's own process (a `shell` command, a path or symlink) are written only into the agent's turn notes and never reach the orchestrator. The daily report says nothing about refusals. Separately, the PR #6 review found that free gate attempts (a refused `serve_endpoint` runs the shared sandbox; a refused link check sends outside requests) have no cap, that a working endpoint that needs a query is unpublished after two re-tests because the re-test sends no query, that a claim refused by the constitution is not logged as a constitution block, and that nothing tests that `buildApp` installs the offer verifier and URL checker.

## Solution

One table, `refusals`, with one row for every refused tool call: the agent, the tool, a rule ID from a closed list, a short sanitised reason, and whether the runtime or the agent's own process reported it. There is a single write point, so no refusal path can skip it. The daily report lists the counts by rule. Free gate attempts are capped per agent per hour. The sample query is stored and reused by the re-test. A claim blocked by the constitution also logs `constitution_block`.

## User Stories

1. As Kevin, I want every refused tool call recorded with a rule ID and a reason, so that I can see which rule refuses an agent and why.
2. As Kevin, I want exactly one row per refusal and none for a success, so that the counts mean something.
3. As Kevin, I want the daily report to list refusal counts by rule, per agent and in total, so that I can read a day at a glance.
4. As Kevin, I want a refusal that happened inside the agent's container (shell, path, symlink) to reach the orchestrator, so that it is not lost in a turn note.
5. As Kevin, I want those agent-reported rows marked as lower trust, because the agent's container could send anything, and bounded, so that a compromised container cannot fill the database.
6. As Kevin, I want the reason text sanitised and short, so that a refusal row cannot carry a prompt injection or a flood.
7. As Kevin, I want a claim refused by the constitution to be a `constitution_block` event as well, so that later breach counts see it.
8. As an agent, I want a working endpoint that needs a query to stay live across re-tests, so that real work is not unpublished by a test with no input.
9. As Kevin, I want a cap on free gate attempts per agent per hour, refused before any sandbox run or URL check, so that an agent cannot starve buyers or ping outside hosts for free.
10. As Kevin, I want a test that `buildApp` installs the real offer verifier and URL checker, so that a mis-wired app is caught.
11. As Kevin, I want the migration to be safe on an existing database, so that the soak DB keeps all its rows.

## Implementation Decisions

**The `refusals` table.** `id` (integer primary key), `agent_id`, `tool`, `rule_id`, `reason` (at most 300 characters, run through `sanitizeSenseText`), `source` (`runtime` or `agent`), `created_at`, with an index on `(agent_id, created_at)`. `CREATE TABLE IF NOT EXISTS`, so an existing database gains it on open.

**Rule IDs: a closed list in `src/refusals.ts`.** Dotted names; the list is a typed constant and nothing else is accepted.
- Gate: `kill_switch`, `agent_status` (also an unknown agent), `unknown_tool`.
- Constitution and owner: `constitution.I`, `constitution.II`, `constitution.III` (from the `law` that `reviewText`, `reviewCommand` and `reviewUrl` already return), `owner.denylist` (law `owner`).
- Ledger: `spend.cap`, `ledger.balance`, `ledger.duplicate` (a call that was already billed).
- Hourly limits: `limit.hourly.see_page`, `limit.hourly.crawl_site`, `limit.hourly.read_feed`, `limit.hourly.browse`, `limit.hourly.claim`, and `limit.offer_checks`.
- Claims: `claim.evidence`, `claim.shape`, `claim.tripwire`.
- Income: `income.self_declared` (`report_income`, `credit_balance`, `claim_payment`).
- Offers: `offer.test_failed`, `offer.unconfigured`, `offer.body_empty`, `offer.link_own_missing`, `offer.link_dead`, `offer.cap`, `offer.price`, `offer.handler` (the snapshot refused: no `handler.js`, bad directory).
- Input and tools: `input.invalid` (bad or missing arguments), `input.conflict` (a name already taken), `tool.disabled`, `tool.unconfigured`, `tool.failed` (the runtime could not complete a step, for instance a disk error).
- Senses: `sense.refused` (the senses service refused the request), `sense.error` (the call failed).
- Other tools: `spawn.refused`, `council.refused`, `pay.refused` (the rule is the tool; the reason carries the detail; a ledger code from deeper down wins).
- Agent side: `local.shell`, `local.path`, `local.symlink`.
- `unclassified`: the last resort. A refusal path with no rule is a gap to be fixed, and the report names any that remain.
Ledger refusals get their rule at the source: `checkSpend`, `authorize` and `post` return a rule code with the error, so it travels through `Result` without matching on message text.

**One write point.** The body of `handleTool` is renamed `handleToolInner`. The public `handleTool` calls it and, for every result with `ok: false`, writes exactly one `refusals` row (`rule ?? "unclassified"`, `source = 'runtime'`) and returns the result with its `rule`. Refusal paths return `{ ok: false, reason, rule }`; every reason string is unchanged. Existing events are unchanged. `balance` and successful calls write no row. Because the rule travels with the result, a path that forgets it shows up as `unclassified`, not as a missing row.

**Agent-side refusals.** `executeLocalTool` keeps returning a string, but a new detailed form also says which local rule refused (`local.shell` for a `reviewCommand` refusal; `local.path` for a path outside the workspace, a reference file write or a path with `..`; `local.symlink` for a link whose real path leaves the workspace). `loop.ts` reports each such refusal through a new `AgentHost.recordRefusal(agentId, tool, rule, reason)`: `HttpHost` posts it to `/internal/agents/<id>/refusal` on the existing token-authenticated route, and `DirectHost` calls the swarm. `Swarm.recordAgentRefusal` stores `source = 'agent'`. Because the agent's container could send anything, the swarm accepts only the three `local.*` rules (anything else is stored as `unclassified`), forces the tool to a short name of lowercase letters and underscores (else `unknown`), sanitises and cuts the reason, and drops rows beyond 200 per agent per hour (a bound on what a compromised container can write). The report lists these separately and says they are lower trust.

**Claim carry-over.** `checkClaim` returns a rule with each rejection: `claim.shape` (empty, too long, bad id list), `claim.tripwire`, `claim.evidence` (an id that is not the agent's own usable row), or `constitution.<law>` for a `reviewText` refusal. A constitution refusal also logs a `constitution_block` event (through `blocked()`) and still logs `claim_rejected`, so it still counts toward `CLAIM_HOURLY_LIMIT`. The claim hourly limit refusal is `limit.hourly.claim`.

**`sample_query` carry-over.** A nullable `endpoints.sample_query` column (JSON text), added by `ensureEndpointColumns` and in the `CREATE TABLE`. `serve_endpoint` stores the sample query it tested with (null when there is none; re-registering replaces it). `retestEndpoints` re-tests with it; a row without one re-tests with an empty query, as before.

**Free-attempt cap.** `OFFER_CHECK_HOURLY_LIMIT` (default 20) per agent. The count is the number of `refusals` rows for that agent in the last hour whose rule is `offer.test_failed`, `offer.link_dead` or `offer.link_own_missing`: the refused tests and the refused link checks. It is read before any sandbox run (in `serve_endpoint`) and before any URL check (in `offer_service` and `publish_page`, and only when the text contains a link that would be checked). At or over the cap the call is refused with `limit.offer_checks`, before the sandbox or the checker is touched. That refusal is recorded but is not one of the three counted rules, so it does not extend its own lockout (the same pattern as `claim_limit`). A passing test or link check is not counted (it costs the fee that follows). Known gap: a test that passes but is then refused for balance or caps was a free sandbox run; it is recorded as the ledger refusal, not counted here.

**Daily report.** `writeDailyReport` gains a "## Refusals" section for the last 24 hours: the runtime-recorded counts by rule in total, then per agent; then the agent-reported counts by rule, marked lower trust, in total and per agent. Rules with no rows are not listed. "None in the last day." when there are no rows.

**Wiring test.** `buildApp` can run without Docker in mock mode (no containers are started until an agent is created), so a test builds the app and asserts it installs a `SandboxOfferVerifier` and an `HttpUrlChecker`. `Swarm.offerPorts()` exposes the two ports for that.

**Config.** `OFFER_CHECK_HOURLY_LIMIT` in `config.ts` and `.env.example`. No new dependencies. Mock mode only.

## Testing Decisions

- Seams: `Swarm.handleTool` with fakes (verifier, URL checker, senses probe, `ManualClock`); `runAgentLoop` with a fake `AgentHost` for the agent-side refusals; `DirectHost` and `HttpHost` through `startServer` for the transport; `writeDailyReport` and `openDatabase` for the report and the migration; `buildApp` for the wiring. No network, no Docker.
- Cases: 1 each of kill switch, unknown tool, over-cap spend, insufficient balance, a sense hourly limit, a claim with a foreign id, `claim_payment`, a failed offer test, a dead link, a link to the agent's own missing page, a refused sense call, an empty offer body, an invalid slug and a senses refusal and error writes exactly one row with the expected rule and a reason; 2 a success writes none; 3 a constitution-blocked claim writes `constitution_block` and the `constitution.<law>` rule; 4 a refused local `shell` command and a symlink `write_file` reach `recordRefusal` and are stored with `source='agent'`, and a hostile container cannot store other rules, other tool names or long reasons; 5 after 20 refused offer checks in an hour the 21st is refused with `limit.offer_checks` and makes no sandbox call or URL check, and it is allowed again after the window; 6 a stored `sample_query` is used by the re-test; 7 the report shows "## Refusals" with correct counts; 8 the migration runs on a database made before this change with all existing rows intact; 9 every existing test passes and a sample of reason strings is unchanged; 10 `buildApp` installs the real verifier and checker.
- Prior art: `test/verify-offer.test.ts`, `test/claims.test.ts`, `test/evidence.test.ts` (a fake `AgentHost` driving `runAgentLoop`).

## Out of Scope

- Judging or steering what an agent sells; changing any reason string; changing any existing event.
- Refusals that are not tool calls (HTTP 402/404 responses to buyers, payment verification failures).
- Alerting or acting on refusal counts (the report only counts).
- Stage 3 items (egress policy, `RUNTIME=process` isolation, the real sandbox and URL checks in the VPS preflight).

## Further Notes

- Agent-reported rows could be forged by a compromised container, which is why they are a separate source, restricted to three rules, bounded and labelled in the report. The runtime-recorded rows are the evidence.
- A refusal of a call the orchestrator already refused is never reported by the agent: the orchestrator refuses first, and the agent only runs what was authorised. The agent-side rules cover what only the agent's process can see (a symlink's real path).
