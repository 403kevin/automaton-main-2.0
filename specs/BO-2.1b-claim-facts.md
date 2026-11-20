# BO-2.1b — `claim` tool, `claims` + `facts` tables, `web_search` through `senseCall`

Spec for ORDER BO-2.1b (section 25 of `AUTOMATON_COLLAB_FOR_GROK.md`). It finishes plan row BO-2.1 ("Evidence ledger + `claim` + facts") after [BO-2.1](BO-2.1-tripwires.md) (evidence rows and tripwires) and [BO-2.1c](BO-2.1c-raw-out.md) (raw files out of the workspace).
Follow-up: [BO-2.2](BO-2.2-no-phantom-products.md) adds `test_delivery` facts, labels the `replication_in` and `owner_topup` credit facts (`payer_class=sibling` / `owner`), and fixes `replication_in` so that it writes a fact at all.
Format: `to-spec` (mattpocock/skills). It lives in `repo/specs/` for the same reason as the earlier specs: `spec-artifact` points at Omega's `20-CONTROL/specs/`, which is outside this git repo and could not be cited from the PR.
Sources: plan lesson 2 (`claim(text, evidence_ids[])` is marked verified only if the rows exist and belong to that agent), the acceptance tests (a claim with someone else's evidence id is rejected; a claim with no evidence id is stored as unverified), and the memory design (a runtime-written `facts` table that is read-only to the agent).

## Problem Statement

An agent that cannot check the world invents it. Today an agent can write anything into its notes (`remember`) and nothing separates what it saw from what it believes. The evidence rows from BO-2.1 record what each sense call returned, but the agent has no way to point at them, and the runtime has no record of "things it observed" that the agent cannot edit. Separately, `web_search` still hands raw search text to the model: it is the last text-returning sense tool that skips the scan, the fence and the evidence row.

## Solution

Two tables with two different writers. `claims` is written by the agent through a new `claim` tool: a statement, plus the ids of evidence rows it rests on. The runtime marks a claim `verified` only if every cited row exists, is the agent's own, and was a usable result; a claim with no ids is stored `unverified`; a bad id rejects the claim and nothing is stored. `facts` is written only by the runtime, from evidence rows and ledger credits, and no tool can write it. The agent sees its own last facts and claims in its wake-up message, inside a fence. `web_search` goes through the same wrapper as the other sense tools. No model judges anything and no prompt tells an agent what to sell.

## User Stories

1. As an agent, I want to record a claim and point it at the evidence it rests on, so that I can tell later what I knew and why.
2. As an agent, I want a claim with no evidence to be stored as unverified, not refused, so that I can note a hunch without it being passed off as checked.
3. As Kevin, I want a claim that cites another agent's evidence to be rejected, so that one agent cannot borrow another's proof.
4. As Kevin, I want a claim that cites a quarantined, refused or errored call to be rejected, so that evidence the runtime did not trust cannot back a claim.
5. As Kevin, I want a rejected claim to cost nothing and leave no row, but to count toward an hourly limit, so that rejected claims cannot be spammed for free.
6. As Kevin, I want a claim statement that is itself an injection to be rejected, so that the agent cannot launder hostile text into its own memory.
7. As Kevin, I want a `facts` table that only the runtime writes, from sense results and from ledger credits, so that there is one record of what actually happened that the agent cannot edit.
8. As an agent, I want to see my own latest facts and claims when I wake up, with the evidence id next to each fact, so that I can cite evidence without guessing ids.
9. As Kevin, I want the wake-up records fenced and bounded, so that they cannot flood the prompt or break out of their fence.
10. As Kevin, I want one agent never to see another agent's records, so that siblings do not leak into each other's context.
11. As Kevin, I want `web_search` output scanned, fenced or quarantined and recorded like every other sense result, so that the last unscanned text door is closed.
12. As Kevin, I want `report_income`, `credit_balance` and `claim_payment` to stay rejected, so that the new `claim` tool is not a way to declare income.

## Implementation Decisions

**`claims` table.** `id` (integer primary key), `agent_id`, `statement` (at most 500 characters), `evidence_ids` (JSON array of integers), `status` (`verified` or `unverified`), `threat_level` (the tripwire level of the statement, `low` or `medium`), `created_at`. Only accepted claims are stored. Created with `CREATE TABLE IF NOT EXISTS`, so an older database gains it on open.

**The `claim` tool.** Arguments: `statement` (text) and `evidence_ids` (an array of whole numbers; a JSON string of an array is also read; numeric strings are accepted; at most 20 ids; duplicates collapse). Order of checks, each stopping at the first failure:
1. **Hourly limit.** `CLAIM_HOURLY_LIMIT` (default 30). Attempts in the last hour = stored claims + `claim_rejected` events. Over the limit the call is refused, costs nothing, and is logged as a `claim_limit` event, which does not count as an attempt (so an agent that keeps trying does not extend its own lockout).
2. **Statement shape.** Empty, or longer than 500 characters, is rejected (not truncated).
3. **Constitution.** `reviewText` on the statement, as `remember` does.
4. **Tripwires.** `guardSenseText` on the statement: `high` or `critical` is rejected; `low` and `medium` are stored (the level goes in `threat_level`).
5. **Evidence ids.** An entry that is not a positive whole number is rejected, naming it. Each id must be an `evidence` row that belongs to the calling agent and has status `ok`. An id that does not exist and an id that belongs to another agent get the same reason ("Evidence id N is not one of your usable evidence rows."), so the tool is not an oracle for other agents' rows. An owned row whose status is `quarantined`, `refused` or `error` is rejected with its status named. A `medium`-threat row with status `ok` is usable.
6. **Fee.** `CLAIM_COST_USD` (default 0.0001) in `toolCosts.claim`, charged only after steps 1 to 5 pass, so a rejected claim costs nothing. An unaffordable claim is refused and costs nothing.
7. **Store.** `verified` if at least one id was given and all passed; `unverified` if no ids were given.
Every rejection in steps 2 to 6 logs a `claim_rejected` event naming the reason and counts toward the limit. The tool result is a short sentence (`Claim 12 stored as verified.`), not an echo of the statement.
The "newer than the claim's subject" check (is the cited evidence recent enough for what the claim says) is deferred: it needs a notion of the claim's subject that this order does not define.

**`facts` table, written only by the runtime.** `id`, `agent_id`, `kind`, `subject`, `value`, `source`, `created_at`. No tool, no tool argument and no public method writes it. Two writers:
- **Sense results.** When an evidence row is written with status `ok`, one fact: `kind` = `sense`, `subject` = the row's url, or its tool name when it has no url, `value` = the row's `output_hash`, `source` = `evidence:<id>`. Quarantined, refused and error rows write no fact.
- **Ledger credits.** When a ledger entry of kind `owner_topup`, `onchain_income`, `x402_in` or `replication_in` is posted with a positive amount, in the same transaction and never for a duplicate, one fact: `kind` = `credit`, `subject` = the ledger kind, `value` = `units=<n> payer_class=<class or none>`, `source` = `ledger:<entry id>`. Refunds, rent and spends write none.
How an agent learns an evidence id: the wake-up lists its own facts with `source` (`evidence:<id>`).

**Wake-up records.** `buildWakeup` gets an optional `ownRecords` string from the snapshot. It lists the agent's own last 10 facts and last 10 claims (claims show their status), newest first, in at most 1200 characters, inside a fence marked `OWN_RECORDS` with its own random nonce, separate from `SENSE_DATA`:

```
<<<OWN_RECORDS nonce=<12 hex>>>>
Your own records. Facts are written by the runtime. Claims are yours.
Facts:
- evidence:7 sense http://example.test/page 3fa9…
- ledger:led1a2 credit x402_in units=2000 payer_class=outside
Claims:
- [verified] <statement>
<<<END_OWN_RECORDS nonce=<same nonce>>>>
```

Statements and subjects are sanitised before they go in, and the fence markers `<<<OWN_RECORDS` / `<<<END_OWN_RECORDS` are defused in them the same way as the sense fence. The cut to 1200 characters happens inside the fence, so the closing line survives. With no facts and no claims, no block is added. Only the agent's own rows are read; no other agent's facts or claims reach it.

**`web_search` through `senseCall`.** It joins the other sense tools: one `evidence` row (tool `web_search`, the query's hash in `input_hash`), fenced or quarantined by the same rules. The tool charges as before and keeps its fee. A search failure becomes a refusal with the error text and the fee kept (before, it returned `ok` with the error text), matching the `fetch_url` precedent. An empty query is refused as before.

**Config.** `CLAIM_COST_USD` and `CLAIM_HOURLY_LIMIT` are added to `config.ts` and `.env.example` (names and defaults only; no key or secret).

**No new dependencies. Mock mode only. No new paid calls. No prompt text that suggests what to sell or to monetise.**

## Testing Decisions

- Seams: `Swarm.handleTool` with a mock senses client and a mock search provider; `Swarm.snapshot` and `buildWakeup` for the records; the `tripwires` pure functions for the second fence. Fixtures only, no network.
- Cases (the order's nine plus the limit):
  1. Valid owned `ok` evidence gives `verified`, and the fee is debited once.
  2. No ids gives `unverified`, stored and charged.
  3. An unknown id, another agent's id, a quarantined id and a refused id are rejected with a reason naming the id; no claim row, no debit.
  4. An injection statement is rejected.
  5. No tool writes `facts`; an `ok` sense call and an incoming credit each write exactly one fact; a quarantined call and a refund write none.
  6. The wake-up shows the agent's own facts and claims, bounded and fenced, the closing fence survives the cut, and no sibling's records appear.
  7. A `web_search` hit that carries injection text is quarantined, with one `web_search` evidence row.
  8. Benign search output comes back unchanged inside the fence at `low`.
  9. `claim_payment` and `report_income` are still rejected, and every existing test passes.
  10. Rejected claims count toward `CLAIM_HOURLY_LIMIT`; over the limit the call is refused and free.
- Prior art: `test/evidence.test.ts` (rig with a probe senses client), `test/search-billing.test.ts` (search provider and fee checks).

## Out of Scope

- Any model or LLM judging a claim; any prompt text about what to sell or to monetise.
- The "newer than the claim's subject" check (deferred, above).
- A tool that reads facts or claims on demand; the wake-up is the only reader.
- Letting a claim affect the ledger, rent, spawning or any limit.
- Stage 3 items (egress policy, `RUNTIME=process` isolation).

## Further Notes

- `claims` are the agent's own words and are not trusted: `verified` means "the evidence it cites is its own and the runtime recorded it as a usable result", not "the statement is true". The statement is shown back to the agent only inside the `OWN_RECORDS` fence, sanitised.
- The two fences have different markers on purpose: a hostile page cannot forge the runtime's own-records fence by copying the sense fence.
