# BO-2.5 — daily report v2 (+ the Nemo soak agent and the soak profile sync)

Spec for ORDER BO-2.5 (section 37 of `AUTOMATON_COLLAB_FOR_GROK.md`), plan row BO-2.5. Follows [BO-2.4b](BO-2.4b-agent-model-compose.md) and [BO-2.7](BO-2.7-predict-settlement.md) and builds on the counts they added.
Format: `to-spec` (mattpocock/skills). It lives in `repo/specs/` for the same reason as the earlier specs: `spec-artifact` points at Omega's `20-CONTROL/specs/`, which is outside this git repo and could not be cited from the PR.
The report only describes what happened. It never ranks agents and never suggests what an agent should sell or predict.

## Problem Statement

The daily report mixes the runtime's own numbers with nothing about what an agent said, has no evidence-coverage or lost-wake rate, shows income without saying which kind is a real-world signal, folds lost wakes into the model section, and says nothing about breaches. Kevin reads it every day of the soak, and the Stage 3 exit numbers (evidence coverage, lost wakes, breaches, phantom offers) must be readable from it. Separately, the soak profile the compose path loads (`config/soak.sepolia.env`) lacks the BO-2.4 settings, so that path would run with no fallback, and Kevin has chosen one soak agent's model.

## Solution

A report whose `##` sections are fixed and in a fixed order, each from the runtime's own tables (the one section that quotes an agent is labelled "what the agent said, not checked"), a snapshot test on a one-day fixture, a script that copies the reports to Kevin's laptop, and the soak profile brought in line with the template with `wick` on `mistralai/mistral-nemo`.

## User Stories

1. As Kevin, I want one section of runtime-only numbers per agent and the four Stage 3 exit numbers for the day, so that I can see at a glance whether the soak is healthy.
2. As Kevin, I want what each agent said (claims, offer descriptions) kept apart, fenced, sanitised and short, and labelled as unchecked, so that an agent's words are never mistaken for facts and cannot break the report.
3. As Kevin, I want claims counted by whether they are verified, outside income kept apart from sibling income and top-ups, and only outside income called a real-world signal.
4. As Kevin, I want lost wakes in their own section with a rate against turns.
5. As Kevin, I want the two prediction metrics an agent can raise by its own actions marked as self-inflatable.
6. As Kevin, I want a breaches section that always appears.
7. As Kevin, I want the report copied to my laptop with one command that uses my own SSH key and writes nothing on the server.
8. As Kevin, I want both soak profiles to agree on every model setting, wick on Nemo, and every allowed model priced.

## Implementation Decisions

**Order.** The report keeps its header and its two existing blocks, "Agents" and "Notable actions" (existing tests and Kevin's habit depend on them), and then these `##` sections in this order:

| # | Section | Source |
|---|---|---|
| 1 | Runtime observed | new, `src/report-v2.ts` |
| 2 | Agent said | new |
| 3 | Claims (verified/unverified) | new |
| 4 | Refusals | existing `refusalReportLines`, unchanged |
| 5 | Offers and test deliveries | new |
| 6 | Money (outside vs sibling, net of cost) | new |
| 7 | Senses usage | new |
| 8 | Lost wakes | new; moved out of "Model reliability" |
| 9 | Model reliability | existing `modelReliabilityLines`; keeps "Turns per served model" and "Assigned and served", loses its "Lost wakes" subsection |
| 10 | Predictions | existing `predictionReportLines`, plus the BO-2.7 note |
| 11 | Breaches | new; "None" when empty, never omitted |

Every section covers the last 24 hours (the existing sections already do) and an empty section says "None in the last day." (Breaches says "None.").

**Runtime observed.** Per living agent, from the runtime's own tables only: turns (rows in `turns`); tool calls seen (billed `tool` debits plus runtime-recorded refusals; a free, successful call leaves no row and is not counted); evidence coverage; spend today against the agent cap and the swarm's spend today against the global cap (`spend` table, today's day key); tier and balance. **Evidence coverage** is the share of paid sense calls that left an evidence row: paid sense calls are the `tool` debits whose note is a sense tool (`SENSE_TOOLS`), and the evidence rows are that agent's rows for those tools in the window; the share is capped at 100% and is "n/a" when the agent paid for no sense call. It is a count comparison, because no table links a debit to its evidence row. Then four Stage 3 exit numbers for the swarm, each with its target and "pass" or "fail" (or "n/a" with no data): evidence coverage at least 95%; lost wakes under 5% of turns; breaches 0; phantom offers published 0. A **phantom offer** is a live endpoint with no passing test delivery on record (its latest `test_delivery` fact for that endpoint is missing or does not match the passing pattern `OK_DELIVERY` exported from `predictions.ts`); the offer gate should make this impossible, and the number says so.

**Agent said.** Per living agent with something to show: its most recent claims (up to 3 in the day) and its offer description (the `services` row and its live endpoints' names), each cut to 120 characters, whitespace collapsed, passed through `sanitizeSenseText`, with `<<<` and `>>>` replaced so an agent cannot forge the fence, and `redact()` applied. The block is fenced `<<<AGENT_SAID agent=<name>>>` … `<<<END_AGENT_SAID>>>` and the section is headed with "What the agent said, not checked." Nothing the agent says is counted anywhere else.

**Claims (verified/unverified).** From `claims` (status and evidence ids) and `facts`: per agent, claims in the day by status, and how many cite evidence ids that exist and belong to that agent. A claim with at least one evidence id is "with evidence"; a claim with none is "without evidence". The section never calls a claim true: "verified" means only that a runtime evidence row exists, as the claim tool already enforces.

**Offers and test deliveries.** Published (`serve_endpoint outcome=ok` events and `services` rows updated in the day), refused (`outcome=refused` events for `offer_service` and `serve_endpoint`), unpublished after failed re-tests (`offer_unpublished` events), and the `test_delivery` facts in the day: passing (matching `OK_DELIVERY`) and not passing, per agent. Pages are not offers and are not counted here.

**Money (outside vs sibling, net of cost).** Per living agent, last 24 hours, from `ledger_entries`: outside income (inbound `x402_in` and `onchain_income` with `payer_class` null or not `sibling`, as the runtime already counts it), sibling income, costs (the kinds `inference`, `tool`, `council`, `rent`, `x402_out`, `replication_out`), net of cost (outside income minus costs, the same definition the spawn gate uses), and owner top-ups and replication endowments shown apart. **Only the outside income line carries the label "real-world signal"**; the sibling line says "not a real-world signal" and the top-up line says "subsidy, not income".

**Senses usage.** Per agent from `evidence` (calls) and the paid sense `tool` debits (cost): searches (`web_search`), page views (`see_page`, `crawl_site`, `read_feed`, `fetch_url`) and browse calls (`browse`), with the total cost of the sense debits.

**Lost wakes.** A top-level section: per agent the lost wakes (`lost_wake` events) against turns, the rate `lost / turns` (turns include the turn recorded for a lost wake) for the swarm and per agent, and the reasons (the `reason=` text of the events, sanitised and cut to 80 characters, counted). "n/a" when there are no turns.

**The BO-2.7 note.** The Predictions section gains, after its lines: "Hit rates on `sense_results` and `test_deliveries_ok` are self-inflatable: an agent can raise them by its own actions. `income_outside_units` is the only real-world signal." The metric names come from the exported `METRICS`. A per-metric line (`- <metric>: settled n, hits h`, with the suffix "(self-inflatable)" on the two) is added so the label sits next to the number.

**Breaches.** Tripwire hits (an `evidence` or a `claims` row whose `threat_level` is not `none`, per agent) and any event of kind `breach` or `ledger_drift` (the runtime's two records of something that must not happen). "None." when there are none. A tripwire hit is a breach attempt the runtime caught, not a breach; the section says so, and the Stage 3 "breaches" number counts only `breach` and `ledger_drift` events.

**Snapshot.** `test/report-v2.test.ts` builds one day with the real writers on a `ManualClock`: two agents, and at least one of each of a claim, a refusal, an offer, a test delivery, a sibling payment, an outside payment, a top-up, a search, a lost wake, a prediction on each metric and a tripwire hit. The report is compared byte for byte with `test/fixtures/report-day.md`. The fixture is generated once by the implementation and then read line by line before it is committed; it is the reviewed expected output, not a mechanical copy. No agent id, address, hash or timestamp that varies between runs may appear in the report. Sense-fence text, an injected fence marker and a secret pattern in an agent's words must not appear raw.

**`scripts/pull-reports.sh <user@host> <local-dir>`.** The reports are written to `DATA_DIR/reports` (`config.ts`; `/app/data` in the container, `DATA_DIR: /app/data` in `docker-compose.soak.yml`), and `/app/data` is the named Docker volume `automaton-data` (`docker-compose.yml`, `volumes:`), not a folder on the host. So the script runs `docker compose cp orchestrator:/app/data/reports -` over SSH and unpacks the tar stream locally with `tar -x`. It writes nothing on the server (the stream goes to standard output), deletes nothing, uses the SSH key Kevin already has, and never sets `StrictHostKeyChecking=no`. The remote project folder is `${AUTOMATON_REMOTE_DIR:-automaton}` (relative to the SSH home) and the compose files and env file are the documented soak command line. With a missing argument it prints usage and exits 2. It is documented in the README.

**The Nemo soak agent and the profile sync.** In `config/soak.env.template` and `config/soak.sepolia.env`: `SOAK_AGENT_MODELS=wick=mistralai/mistral-nemo` (Kevin's decision, 2026-11-20 1:32 PM CST; `wick` is Grok's pick and Kevin may change it); `ALLOWED_MODELS=mistralai/mistral-small-3.2-24b-instruct,google/gemini-2.5-flash-lite,mistralai/mistral-nemo`; and the template's `FALLBACK_MODELS` and `MODEL_PRICES` lines, with their dated sources, copied into the sepolia profile. A test loads both files through `loadConfig` and `parseSoakAgentModels` and checks that they agree on every model key, that wick's model is allowed, and that every allowed model has a price. This replaces the BO-2.4b "slot" test, which expected the slot to stay commented out: the slot is now filled by Kevin's decision.

**No new dependencies. No model ID in `src/`. No change to any guard, cap or tool. Mock mode only.**

## Testing Decisions

- Seams: `Swarm.writeDailyReport` on a harness with a fake clock (the fixture); the new section functions through the report; `loadConfig` and `parseSoakAgentModels` on the two profile files; `bash scripts/pull-reports.sh` run with no arguments.
- Cases: section order and "None" for empty sections; lost wakes as a top-level section with its rate; the money split and its labels; the self-inflatable labels; no raw fence, injected marker or secret; the profiles agree, wick is on Nemo and every allowed model is priced; the script's usage and exit code; the snapshot; every existing test (any existing report assertion that moves is updated, with the reason in the report).
- Prior art: `test/model-reliability.test.ts` and `test/predictions.test.ts` (report sections), `test/refusals.test.ts` (refusal cases), `test/outside-money.test.ts` (payer classes), `test/agent-model.test.ts` (the soak files).

## Out of Scope

- Ranking, scoring or advising anything; a dashboard version of the report; changing how any number is recorded.
- A live check that the script reaches a real server.
- Plan row BO-2.6 (sibling payments tagged and not unlocking `spawn_child`), which main already holds: `test/outside-money.test.ts`, "tags a sibling payment as sibling and does not unlock spawn; the same size from outside does".

## Further Notes

- Evidence coverage compares counts (paid sense calls against evidence rows), so a paid call with no evidence row shows as a shortfall, but an evidence row cannot be matched to its debit.
- "Tool calls seen" misses free successful calls by construction; no table records them.
