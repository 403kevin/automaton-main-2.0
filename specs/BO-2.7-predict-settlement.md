# BO-2.7 — `predict` + settlement (+ PR #7 carry-over)

Spec for ORDER BO-2.7 (section 31 of `AUTOMATON_COLLAB_FOR_GROK.md`), plan row BO-2.7: a prediction is stored before the action; at the deadline the runtime writes the actual number from the facts table; the report shows the hit rate per agent. It borrows the self-calibration bookkeeping loop and installs nothing. Follows [BO-2.3](BO-2.3-refusal-records.md); the facts it settles on are written by [BO-2.1b](BO-2.1b-claim-facts.md) and [BO-2.2](BO-2.2-no-phantom-products.md).
Follow-up: [BO-2.5](BO-2.5-report-v2.md) adds the self-inflatable note to the Predictions section of the daily report.
Format: `to-spec` (mattpocock/skills). It lives in `repo/specs/` for the same reason as the earlier specs: `spec-artifact` points at Omega's `20-CONTROL/specs/`, which is outside this git repo and could not be cited from the PR.
The runtime only keeps score. The metrics are neutral counts and sums of runtime facts. Nothing here suggests what to sell or what to predict.

## Problem Statement

An agent decides for itself what to do, but it has no way to learn whether its own expectations were right. It can write a claim ("I expect this to earn something"), but a claim is words, and nothing scores it against what actually happened. The runtime already records what happened as facts (sense results, credits, test deliveries) that no agent can write, so the evidence for scoring exists. What is missing is a place for an agent to commit to a number before the fact, and a settlement step that compares it with the facts afterwards, so that the record, and the agent's own context, shows a hit rate.

## Solution

A `predict` tool stores a prediction: a metric from a closed list, a comparison, a whole number and a deadline. Predictions are immutable once stored. At the first maintenance pass after the deadline the runtime computes the actual value of the metric from that agent's own facts in the window (strictly after the prediction, up to the deadline), and marks the prediction `hit` or `miss`. The agent sees its last settled predictions in its own records; the daily report shows the hit rate per agent. Separately, two free paths from the BO-2.3 review are closed: an agent that cannot afford a fee no longer gets free sandbox runs or URL checks on the way to being refused.

## User Stories

1. As an agent, I want to record a numeric prediction before I act, so that I can later see whether I was right.
2. As Kevin, I want the metrics to be a closed list computed only from runtime facts, so that no agent can mark its own homework.
3. As Kevin, I want a prediction to be impossible to edit or delete, so that the record cannot be rewritten after the fact.
4. As Kevin, I want a prediction settled at its deadline from the facts after it was made, so that a lucky earlier event cannot count.
5. As Kevin, I want settlement to be idempotent and to cover a dead agent's predictions, so that the record is complete and a repeated pass changes nothing.
6. As an agent, I want my last settled predictions in my own records, so that I can calibrate.
7. As Kevin, I want the report to show settled, hits and hit rate per agent, plus the number still open, so that I can read calibration at a glance.
8. As Kevin, I want a rejected prediction to be free, to leave one refusals row with a rule ID, and to count toward an hourly limit, so that rejected predictions cannot be spammed for free.
9. As Kevin, I want a cap on open predictions per agent, so that the table cannot be filled.
10. As Kevin, I want an agent that cannot afford `serve_endpoint` to be refused before any sandbox run, and one that cannot afford `offer_service` or `publish_page` to be refused before any outside URL check, so that being nearly broke is not a source of free work.

## Implementation Decisions

**The `predict` tool.** Arguments: `metric` (a name from the list below), `op` (`>=`, `<=` or `=`), `value` (an integer of 0 or more; a numeric string is accepted), `deadline_hours` (an integer from 1 to 168) and an optional `note` (at most 300 characters). The note goes through `reviewText` and `guardSenseText` exactly as a claim statement does: a high or critical note is rejected, and a constitution refusal also logs a `constitution_block` event. The tool description names the metrics and the limits and says nothing about what to predict or sell.

**The metric list, closed**, each computed only from the agent's own `facts` with `created_at` strictly after the prediction's `created_at` and at or before its `deadline_at`:
- `income_outside_units`: the sum of `units` in `credit` facts whose subject is `onchain_income` or `x402_in` and whose payer class is not `sibling` and not `owner`. This matches the ledger's `outsideIncome` (a missing class counts as outside).
- `income_sibling_units`: the same facts whose payer class is `sibling` (the ledger's `siblingIncome`). A `replication_in` credit is a subsidy, not income, and is not counted, as in the ledger.
- `test_deliveries_ok`: the count of `test_delivery` facts whose value is `code=ok bytes=<n>`.
- `sense_results`: the count of `sense` facts.

**How the values are read: strict parsing, no new column.** The alternative was a nullable numeric `facts.amount` column added by migration and filled by every fact writer. I chose strict regexes over the existing text values (`^units=(\d+) payer_class=([a-z_]+)$` for credits, `^code=ok bytes=\d+$` for deliveries) because: only the runtime writes facts, in fixed formats it controls, so a regex cannot be fed hostile text; the facts written by BO-2.1b and BO-2.2 would not need a backfill; and it changes no table that other code writes. The cost is that settlement does the arithmetic in code over the facts in the window, which is bounded by one agent's activity in at most 168 hours. A row that does not match its format is skipped (the writers cannot produce one). If a later metric needs a numeric column, adding it is a separate migration.

**The `predictions` table.** `id`, `agent_id`, `metric`, `op`, `value`, `note`, `created_at`, `deadline_at`, `status` (`open`, `hit` or `miss`), `actual`, `settled_at`, with an index on `(status, deadline_at)`. `CREATE TABLE IF NOT EXISTS`, so an existing database gains it on open. **Immutability is enforced in the database**, not only by the absence of a tool: a trigger aborts any `DELETE`, any `UPDATE` of `agent_id`, `metric`, `op`, `value`, `note`, `created_at` or `deadline_at`, and any `UPDATE` of a row whose status is no longer `open`. The only change the runtime can make is settlement, from `open` to `hit` or `miss` with `actual` and `settled_at`.

**Fee and limits.** `toolCosts.predict` from `PREDICT_COST_USD` (default 0.0001), `PREDICT_HOURLY_LIMIT` (default 10), and at most 20 open predictions per agent. Checks run in this order and stop at the first failure, before any charge, so a rejected prediction is free:
1. The hourly limit: stored predictions plus refused predictions in the last hour (read from the refusals table, tool `predict`, runtime rows). A refusal for this limit is recorded but is not counted, so it does not extend its own lockout (the same pattern as the claim and offer-check limits). Rule `limit.hourly.predict`.
2. Shape: the metric, the op, the value, the deadline and the note's length (at most 300 characters). Rule `predict.shape`.
3. The note: `reviewText` (rule `constitution.<law>`), then `guardSenseText` (rule `predict.tripwire`).
4. The open cap: 20 open predictions. Rule `predict.open_cap`.
5. The fee, through `chargeTool`; an unaffordable fee is refused with the ledger rule.
Each refusal writes one `refusals` row through the existing single write point. New rule IDs: `predict.shape`, `predict.open_cap`, `predict.tripwire`, `limit.hourly.predict`.

**Settlement.** `runMaintenance` settles every open prediction whose `deadline_at` is strictly before the current time, at the first pass after that: it computes `actual` from the facts, then sets `hit` or `miss`, `actual` and `settled_at`. A prediction settles once; a second pass finds nothing open past its deadline and changes nothing. It runs for every agent, including a dead (archived) one, so the record is complete. The comparison is `actual >= value`, `actual <= value` or `actual = value`.

**Own records and the budget.** `ownRecords` gains the agent's last 5 settled predictions, newest settled first, one line each: `[hit] income_outside_units >= 100000 -> 120000`. They go in the same `OWN_RECORDS` fence and the same 1200-character budget. **How the budget is shared:** the total stays 1200 characters, cut inside the fence at the end as before; the sections are ordered facts, then predictions, then claims, so the claims (long, agent-written, up to 500 characters each) are the part that gives way first; the prediction lines are short and fixed in shape (at most five of roughly 60 characters). An agent with no settled predictions sees no predictions section; a block is added when there is any fact, claim or settled prediction.

**Report.** `writeDailyReport` gains "## Predictions" for the last 24 hours: for each agent with a prediction settled in that window or still open, the number settled, the number of hits, the hit rate, and the number open, in one line (`- <name>: settled 3, hits 2, hit rate 67%, open 1`; `hit rate n/a` when none settled). Agent names are sanitised. With nothing, "None in the last day."

**Carry-over (ruling b from the BO-2.3 review).** An agent that cannot pay a fee could previously run the sandbox or the URL checker for free and then be refused for balance. Now the fee is checked first (balance and the agent and global spend caps, through `checkSpend`):
- `serve_endpoint` checks `serveEndpointPriceUnits` before the offer-check cap and before the handler test, refusing with `ledger.balance` or `spend.cap` without touching the sandbox.
- `offer_service` and `publish_page` check their fee before any outside URL check (and before the offer-check cap), when the text has a link to check. Text with no link is not affected.

**Config.** `PREDICT_COST_USD` and `PREDICT_HOURLY_LIMIT` in `config.ts` and `.env.example`. No new dependencies. Mock mode only. A README section for `predict`.

## Testing Decisions

- Seams: `Swarm.handleTool` with fakes and a `ManualClock`, settlement through `advance()`/`runMaintenance`, `ownRecords` and `writeDailyReport` for what is shown, `openDatabase` for the migration and the triggers. No network, no Docker.
- Cases: 1 a valid prediction is stored `open`, charged once, and made before any fact it settles on; 2 a bad metric, op, value or deadline, a hostile note, the open cap and the hourly limit each refuse for free with the right rule and one refusals row; 3 nothing settles before the deadline; 4 `income_outside_units` counts an outside `x402_in` credit but not a sibling or owner credit, and ignores facts before the prediction, after the deadline, and another agent's; 5 `test_deliveries_ok` and `sense_results` settle correctly and each of `>=`, `<=`, `=` gives the expected hit or miss; 6 a second pass changes nothing; 7 no tool and no SQL `UPDATE` or `DELETE` can change a prediction; 8 own records show settled predictions, bounded and fenced; 9 the report shows the right hit rates; 10 an agent that cannot afford `serve_endpoint` is refused with `ledger.balance` and makes no sandbox call, one that cannot afford `publish_page` makes no URL check; 11 the migration on a database made before this change keeps every row; 12 all existing tests pass.
- Prior art: `test/claims.test.ts`, `test/refusals.test.ts`, `test/verify-offer.test.ts`.

## Out of Scope

- Any metric not in the list; predictions about another agent; a tool to read or list predictions on demand (the agent sees its last settled ones in its own records).
- Acting on a hit rate (no limit, price or reward depends on it).
- Judging or suggesting what an agent sells or predicts.
- Stage 3 items.

## Further Notes

- The metrics describe what the facts table says happened to this agent, not whether an agent's action caused it.
- Settlement uses the facts that exist at the pass, so a fact written after the deadline cannot enter (strictly after the prediction, at or before the deadline), and a fact created after a late pass cannot be counted twice: the prediction is already settled.
- The prediction `note` is agent-written and is shown to nobody but the agent's own records (it is not in the one-line form), and never in the report.
