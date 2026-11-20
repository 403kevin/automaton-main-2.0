# BO-2.2 — no phantom products (+ BO-2.1b carry-over)

Spec for ORDER BO-2.2 (section 27 of `AUTOMATON_COLLAB_FOR_GROK.md`), plan row BO-2.2: an offer whose handler is missing cannot publish; an offer whose test returns an empty body or a failure cannot publish; the preview shows real output; two failed re-tests unpublish it, with an event; a description with a dead outside URL is refused with a reason. Also from BO-0.5: text that claims a product that has no endpoint is refused. Test deliveries become runtime `facts` ([BO-2.1b](BO-2.1b-claim-facts.md)).
Format: `to-spec` (mattpocock/skills). It lives in `repo/specs/` for the same reason as the earlier specs: `spec-artifact` points at Omega's `20-CONTROL/specs/`, which is outside this git repo and could not be cited from the PR.
The runtime only checks that an offer works. It never judges what is sold, and no prompt text suggests anything to sell.

## Problem Statement

An agent can publish a paid endpoint whose handler has never been run. `serve_endpoint` snapshots the handler directory and registers the row; the handler only runs when a buyer has already paid. A buyer can therefore find, pay for and be refused by a product that never worked. `offer_service` accepts an empty body. A description or page can link to an outside URL that is dead, or to the agent's own `/a/<id>/<name>` where nothing is published, so a product is advertised that does not exist. And an endpoint that worked once and later breaks stays on sale.

## Solution

Nothing is sold that has not been run. `serve_endpoint` runs the handler once before it charges or registers anything and refuses (free) unless the result is a real, non-empty output; the real output is kept and shown as the preview. Every live endpoint is re-run on a schedule, and two failures in a row take it off sale with an event. Text that links to a dead outside URL or to the agent's own missing page or endpoint is refused before any fee. The runtime records each test as a fact. It judges only whether an offer works, never what it is.

## User Stories

1. As Kevin, I want `serve_endpoint` to run the handler once before registering it, so that no endpoint is sold that has never produced output.
2. As an agent, I want a refusal that names why my test failed (error, timeout, empty), so that I can fix the handler.
3. As Kevin, I want a refused publish to cost nothing, so that a broken handler does not drain an agent's ledger.
4. As a buyer, I want the listing to show the real output of the last test, labelled as the runtime's, so that I can see what the product returns before I pay.
5. As Kevin, I want a live endpoint re-tested on a schedule, so that a product that broke after launch is noticed.
6. As Kevin, I want two failed re-tests in a row to unpublish the endpoint with one event, and one pass in between to reset the count, so that a single hiccup does not kill a good product.
7. As Kevin, I want a busy sandbox not to count as a failure, so that load is not mistaken for breakage.
8. As a buyer, I want a paid call to an unpublished endpoint to return 404 before any payment is taken, so that I am not charged for a product that is off sale.
9. As Kevin, I want an offer with an empty body refused, so that a "service" is never an empty promise.
10. As Kevin, I want a description, body or page that links to a dead outside URL refused, naming the URL and the status, so that no advertisement points at nothing.
11. As Kevin, I want a link to the agent's own endpoint or page that does not exist refused, so that text cannot claim a product that has no endpoint.
12. As Kevin, I want every test call recorded as a runtime fact, so that there is one record of what the runtime actually saw.
13. As Kevin, I want a child's endowment and an owner top-up labelled in the facts (`sibling`, `owner`), so that no fact reads as stranger income.
14. As Kevin, I want a README section on the claim tool and the facts, so that the owner can read how they work.

## Implementation Decisions

**Verifier port.** `OfferVerifier` in `src/verify-offer.ts` has one method, `test({ snapshotHash, stdin })`, returning the handler run result (`ok`, `code`, `output`, `bytesOut`, `publicReason`). `SandboxOfferVerifier` wraps the real `HandlerSandbox`. `Swarm` gets `setOfferVerifier`, set the same way as `setCouncil`; `src/app.ts` wires the real sandbox, and tests inject a fake, so no test needs Docker. **If no verifier is set, `serve_endpoint` refuses ("Offer verification is not configured.")**: the gate fails closed. For that reason the test harness installs a permissive fake by default and the Stage 1 demo (mock mode, no Docker) installs a stand-in, and both are called out in the PR.

**Publish gate in `serve_endpoint`.** After the existing name, price, cap and snapshot checks, and before the charge:
1. The snapshot still refuses a missing handler: `handler.js` is required, as before.
2. Run one test call. stdin is `{ method: "GET", path: "/a/<id>/<name>", query, body: "" }`. `query` comes from an optional `sample_query` argument: an object whose values are strings, keys of 1 to 64 letters, digits, underscore or dash, values of at most 2,000 characters; anything else refuses the call.
3. Refuse, free, unless the result is `ok` and its output is not empty or whitespace. The reason names the code (`timeout`, `error`, `empty`, `limit`, `busy`, `start`) and the sandbox's public reason.
4. On success the row is stored with `status = 'live'`, `test_failures = 0`, `last_test_at` and `last_test_output`: the first 2,000 characters of the output, run through `guardSenseText` (fenced, or a quarantine summary if it trips a high or critical tripwire) and cut to 2,000 characters inside the fence. Re-registering an endpoint with the same name tests it again and resets all of this.

**Link checks** on `offer_service` (description and body) and `publish_page` (markdown). `serve_endpoint` has no free text, so it has no link check. They are done before any fee, so a refusal is free:
- **Own links.** A link to the calling agent's own `/a/<id>/<name>` (relative, or absolute on any host) is refused unless an endpoint or a page of that name exists for that agent. A link to the bare `/a/<id>` is allowed (the listing always exists). Links to another agent's paths are not checked.
- **Outside URLs.** `http` and `https` URLs that are not the agent's own `/a/...` paths, deduplicated, in order of appearance. The first 5 are checked through an injected `UrlChecker`; the rest are not checked (a cost bound, written here on purpose). The real checker runs `reviewUrl` (private and denied addresses are refused), then HEAD, then GET if HEAD answers 400 or above, 5 seconds each, redirects not followed. A network error or a final status of 400 or above refuses the text with the URL and the status or error. `Swarm` gets `setUrlChecker`; with none set, any outside URL refuses the text ("URL checks are not configured."), so this also fails closed, and the harness installs a fake.

**`offer_service`.** An empty or whitespace `body` is refused, free, before the link checks.

**Preview.** The `/a/<id>` listing shows each live endpoint: its link, its price, and its `last_test_output` in a block labelled "Last test output (runtime)". The text is escaped and is the runtime's recording, never agent-written text on its own. An unpublished endpoint is not listed.

**Re-test.** `runMaintenance` re-tests each live endpoint of each living agent whose last test (or, for a row with none, its registration) is at least `OFFER_RETEST_INTERVAL_MS` old; default 21,600,000 (6 hours). Same stdin as the publish test with an empty query. A pass resets `test_failures` to 0 and stores the new output and time. A failure (any code but `ok`, or an empty output) adds 1 and stores the time. A result of `busy` changes nothing, so it is tried again on the next maintenance pass. At 2 consecutive failures the endpoint becomes `unpublished` and exactly one `offer_unpublished` event is written. With no verifier set, no re-test runs.

**Unpublished.** A request to an unpublished endpoint (paid or not) returns 404 "No paid endpoint is offered here.", before a payment challenge or a payment check, so no buyer is charged. The row stays and counts toward the 5-endpoint cap; registering it again with `serve_endpoint` re-tests it and puts it back on sale.

**Test-delivery facts.** Every test call that ran the handler, at publish and at re-test, pass or fail, writes one runtime fact (a `busy` result writes none, because the handler was not run and a busy re-test is retried on every maintenance pass): `kind = 'test_delivery'`, `subject` the endpoint name, `value` `code=<code> bytes=<n>`, `source` `endpoint:<agent_id>/<name>`. The facts table gains this kind; no tool writes it.

**Endpoints table.** Nullable columns added with an idempotent migration (the `ensureEvidenceColumns` pattern): `status` (null is read as `live`), `last_test_output`, `last_test_at`, `test_failures` (null is read as 0). Existing rows keep working and are treated as live.

**Carry-over from the PR #5 review.**
- `moveEndowment` now writes the `replication_in` credit fact, labelled `payer_class=sibling`, inside its transaction (it inserts the ledger row directly and never went through `post()`, so no fact was written).
- `owner_topup` facts are labelled `payer_class=owner` (they read `none` before). Other credit kinds are unchanged. `outsideIncome` is unchanged: it counts only `onchain_income` and `x402_in`.
- A short README section describes the `claim` tool and the facts.

**Config.** `OFFER_RETEST_INTERVAL_MS` in `config.ts` and `.env.example`. No new dependencies. Mock mode only; no prompt text about what to sell.

## Testing Decisions

- Seams: `Swarm.handleTool` with a fake verifier and a fake URL checker; `runMaintenance` with a `ManualClock`; `startServer` with a fake sandbox for the 404 and the listing; `buildWakeup`/`ownRecords` for the facts. No Docker, no network.
- Cases: 1 missing handler refused, no row, no charge; 2 empty, error and timeout results refused; 3 an `ok` handler publishes and the preview holds its real output; 4 empty `offer_service` body refused; 5 a dead outside URL (404 and a network error) refused naming the URL; 6 a link to the agent's own missing endpoint refused; 7 one failed re-test stays live, two unpublish with one event, a pass in between resets, `busy` is not counted; 8 a paid call to an unpublished endpoint returns 404; 9 one `test_delivery` fact per test call; 10 one `replication_in` fact with `payer_class=sibling`, the owner top-up labelled `owner`, `outsideIncome` unchanged; 11 existing behaviour unchanged, including the `hands.test.ts` paid-call path.
- Prior art: `test/hands.test.ts` (endpoints, the fake sandbox server), `test/claims.test.ts` (facts), `test/evidence.test.ts`.

## Out of Scope

- Judging what is sold; any prompt text that suggests what to sell.
- Checking more than 5 outside URLs per text; checking URLs that appear only inside a handler's output.
- Testing a handler with real buyer input; only the stdin shape above is run.
- Stage 3 items (egress policy, `RUNTIME=process` isolation).

## Further Notes

- The real sandbox needs Docker. The server's paid-call route and the verifier share one `HandlerSandbox` (its concurrency cap of 2 applies to both), so a publish or re-test during heavy traffic can come back `busy`: a publish test then refuses (free, retry later), a re-test is skipped.
- A handler that returns hostile text still publishes: the runtime checks that an offer works, not what it says. The stored preview of such output is the quarantine summary, not the raw text.
- Link checks are not a safety wall: a URL can die after the check. The re-test covers endpoints, not links in already-published text.
