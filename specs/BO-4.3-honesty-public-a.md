# BO-4.3 — Claim honesty check, Stage 4 report counters, and `/a/*`-only testnet prep

Spec for ORDER BO-4.3. Format: `to-spec` (mattpocock/skills). Lives in `repo/specs/` so the PR can cite it, same as earlier Automaton specs. Follows `BO-4.2-feeds-ship-idle.md`.

## Problem Statement

Stage 3 agents stored claims such as "I earned $0.01" or "my endpoint is live" while the runtime's own tables showed no income, no live endpoint and no passing test delivery. A claim row says "verified" only when its cited evidence is usable, and it says nothing about whether the statement is true, so the agent's own memory can fill with milestones that never happened. Kevin also cannot read the Stage 4 exit numbers (cap-skipped wakes, length-truncated turns, live tested endpoints, outside income, contradicted claims) from the daily report, so a Stage 4 day has to be counted by hand. And the one thing Stage 4 needs from the outside world, a single external Base Sepolia buyer wallet making a test purchase, has no safe way in: the only HTTP listener also serves the dashboard, `/api/*`, `/admin/*` and `/internal/*`, so opening it to the internet would expose all of them.

## Solution

Reject a claim, before anything is charged or stored, when it asserts a runtime-verifiable milestone (money earned, an endpoint live, a test delivery passed) that the ledger, the endpoints table or the facts table contradicts. Record the rejection as a refusal under a new rule, `claim.contradicts_facts`. Add a "Stage 4 readiness" block to the daily report directly below the Stage 3 exit numbers, from the runtime's own tables. Add an optional second HTTP listener that serves only the agent routes (`/a/*`) so Kevin can publish one port for a Base Sepolia test-buy while `/`, `/health`, `/api/*`, `/admin/*` and `/internal/*` stay on the loopback/SSH-only port; it is off by default, refuses to start on mainnet, can be limited to a list of buyer wallets, and is published only by an opt-in compose override.

## User Stories

1. As Kevin, I want a claim like "I earned $0.01" refused when the agent's ledger holds no earned income, so an agent cannot write income into its memory that it never received.
2. As Kevin, I want "I received a payment" and "I was paid" refused in the same case, so the wording does not matter.
3. As Kevin, I want a claim naming a dollar amount refused when the amount is greater than the agent's recorded earned income, so a small real payment cannot back a large claim.
4. As Kevin, I want a claim of "outside income" refused when the agent's outside income is zero, even if it has sibling income, so a sibling payment cannot pass as a real-world signal.
5. As Kevin, I want "earned $0", "no income" and "I have not been paid" accepted, so an honest zero is never blocked.
6. As Kevin, I want a claim that an endpoint is live, published or on sale refused when the agent has no live endpoint, so an agent cannot claim a product that is not on sale.
7. As Kevin, I want "my endpoint is not live yet" and "I will publish an endpoint" accepted, so honest negations and plans are never blocked.
8. As Kevin, I want a claim that a test delivery or handler test passed refused when the agent has no test delivery fact with `code=ok`, so an agent cannot claim a test it never passed.
9. As Kevin, I want "Trail Runner 2 costs $89" and "I expect a buyer soon" still accepted, so ordinary observations and expectations are untouched.
10. As Kevin, I want each of these claims accepted once the matching ledger row, live endpoint or passing test delivery fact exists, so the check follows the truth and does not block honest agents.
11. As Kevin, I want these checks to run only after the shape, constitution, tripwire and evidence checks pass, so earlier refusals keep their own rules and reasons.
12. As Kevin, I want a contradicted claim to write a `claim_rejected` event and a `refusals` row with rule `claim.contradicts_facts`, and to charge no claim fee and store no claim, so it is free and visible.
13. As Kevin, I want the rejection to count toward the hourly claim limit like any other rejected claim, so an agent cannot probe the check without limit.
14. As an agent, I want the refusal reason to say which fact contradicts the claim, so I can correct course.
15. As Kevin, I want the Stage 3 exit numbers block unchanged, so every Stage 3 assertion and fixture line stays valid.
16. As Kevin, I want a "Stage 4 readiness (swarm, last 24 hours)" block directly under it, so the Stage 4 numbers are read in one place.
17. As Kevin, I want a cap-skipped wakes line (skipped wakes against all turns, target under 20%), so I can see how often the spend cap stopped inference.
18. As Kevin, I want a length-truncated turns line (truncated turns against served turns, target under 5%), so I can see whether the output limit cuts agents off.
19. As Kevin, I want a live tested endpoints line (target at least 1), so I can see whether any endpoint on sale has passed its test delivery.
20. As Kevin, I want an outside income line in dollars (target above $0.00) that leaves sibling income out, so only a real-world payment moves it.
21. As Kevin, I want a contradicted claims refused line, so I can see how often agents tried to claim something false.
22. As Kevin, I want a percentage shown as "n/a" with its counts when the denominator is zero, so an empty day is not shown as 0%.
23. As Kevin, I want a `PUBLIC_PORT` setting, default 0 (off), so nothing new listens unless I turn it on.
24. As Kevin, I want a `PUBLIC_HOST` setting, default `0.0.0.0`, so the public listener can bind to an address I choose.
25. As Kevin, I want a `PUBLIC_BUYER_ALLOWLIST` of wallet addresses, so the test-buy can start with my one external buyer wallet.
26. As Kevin, I want a malformed address in that list to stop the orchestrator at start-up, so a typo cannot silently open the listener to everyone or lock out my buyer.
27. As Kevin, I want an empty list to mean any buyer may pay, and addresses compared in lower case, so the default is open and the comparison is not case-sensitive.
28. As Kevin, I want the orchestrator to refuse to start the public listener when mainnet is allowed, so this prep can only ever serve Base Sepolia.
29. As Kevin, I want the public listener to answer only `/a/<agent>`, `/a/<agent>/` and `/a/<agent>/<name>`, so nothing else on the orchestrator is reachable from the internet.
30. As Kevin, I want every other path on the public listener, including `/`, `/health`, `/api/overview`, `/admin/*` and `/internal/*`, to answer 404 "Not found.", so it reveals nothing about what else exists.
31. As Kevin, I want a malformed `/a/` path on the public listener to answer 400, as it does on the main listener.
32. As Kevin, I want a paid request from a wallet that is not on the list to answer 403 after the payment is checked and before any money moves or any handler runs, so a stranger can neither spend the agent's compute nor settle a payment.
33. As Kevin, I want the held payment nonce released in that case, so the owner of the nonce can retry from an allowed wallet.
34. As Kevin, I want an allowed wallet to pay and be served exactly as on the main listener, so the test-buy exercises the real path.
35. As Kevin, I want the list to apply only on the public listener, so local and SSH use of `/a/*` is unchanged.
36. As Kevin, I want closing the server to close both listeners, and the server handle to report the public address, so scripts and tests can reach it and shut it down.
37. As Kevin, I want an opt-in compose override that publishes only port 4748, with no secrets, so I can expose the public listener for Stage 4 and not before.
38. As Kevin, I want the existing safe compose file unchanged (dashboard on loopback only), so the default deploy stays closed.
39. As Kevin, I want the new settings in `.env.example` and both soak profiles, which stay identical except `MONEY_MODE`, with the allow-list left empty for Kevin to fill on the server.

## Implementation Decisions

**Claim honesty check.** `checkClaim` gains a facts step that runs last, after the shape, constitution, tripwire and evidence checks, and returns `{ ok: false, reason, rule: "claim.contradicts_facts" }`. The new rule id is added to the closed rule list. The statement is read clause by clause: it is split on sentence ends, semicolons, newlines, commas that are not inside a number, and the words "and", "but", "while", "so", "although" and "though". Typographic apostrophes are normalised first. A clause is skipped, never checked, when it contains a negation or an explicit zero amount ("no", "not", "never", "zero", "none", "nothing", "without", "haven't", "didn't", "yet to", "still waiting" and similar; or only zero dollar amounts such as `$0` and `$0.00`), when it states a plan, hope or expectation ("expect", "hope", "plan", "will", "would", "could", "should", "might", "want", "if", "going to", "try" and similar), or, for a money clause, when it names a subsidy rather than income (top-up, endowment, seed, funded, deposit, allowance, grant, gift, owner, parent, creator). Anything else is checked in this order, and the first contradiction is returned.

- *Money.* A clause asserts money when it pairs a receiving verb with a money object (an amount, USDC, dollars, money, income, revenue, payments, sales, profit, earnings, cash). Verbs: earned, received, collected, banked, netted, pocketed, gained, generated, booked, "took in", and "made" when the object is an amount or an income word (a made *payment* is spending and is not matched). It also asserts money in the passive and third-person forms: "was/were/been/got paid", "paid me/us/my ...", "a buyer/customer/client/someone paid/bought", "bought my ...". A money object followed by a technical noun ("payment endpoint", "price", "header", "wallet") is not a money object. The agent's earned income is the sum of its `ledger_entries` of kind `onchain_income` or `x402_in` with a positive amount. The claim is contradicted when that sum is zero, or when the first dollar amount named after the verb is greater than it. An "outside income" clause (outside income, revenue, payments, money or earnings, with a receiving or having verb or an amount) is checked against the outside part of the sum (payer class missing or not `sibling`), so the claim is contradicted when outside income is zero or the amount is greater than it.
- *Live endpoint.* A clause asserts a live endpoint when it contains the word "endpoint" with live, published, on sale, for sale, selling, deployed, serving, online, available, listed, registered, shipped or running. The claim is contradicted when the agent has no endpoint with status `live` (or no status).
- *Passing test delivery.* A clause asserts a passing test delivery when it names a test delivery, delivery test, handler test or endpoint test with passed, passes, succeeded, successful, ok, green or worked. The claim is contradicted when the agent has no `test_delivery` fact whose value matches the passing-delivery pattern (`code=ok bytes=<n>`).

The check is a conservative wording filter for the three milestone families above; it is not a truth oracle and does not try to understand every phrasing. Statements outside those families, including product and price observations and future expectations, are never touched.

**Claim tool.** The swarm's claim path already refuses on any failed `checkClaim`: it writes the `claim_rejected` event, returns the rule so the single refusal write point records a `refusals` row, and returns before the fee. That path is confirmed by tests and left as it is; there is no new charge, no stored claim and no new event kind.

**Report.** `runtimeObservedLines` keeps the Stage 3 block as is and then adds `### Stage 4 readiness (swarm, last 24 hours)`, a blank line after the Stage 3 block's own, with five lines, all over the same 24-hour window as the Stage 3 numbers and all from runtime tables:
`- cap-skipped wakes (target under 20% of turns): <pct or n/a> (<skipped> of <turns>)` (turns whose content starts with "Inference skipped:", against all turns);
`- length-truncated turns (target under 5% of served): <pct or n/a> (<truncated> of <served>)` (`inference_truncated` events, against turns that record a model);
`- live tested endpoints (target at least 1): <count>` (live endpoints whose latest `test_delivery` fact matches the passing pattern, subject = the endpoint name);
`- outside income (target above $0.00): $<usd>` (inbound ledger income whose payer class is missing or not `sibling`, formatted like the Money section);
`- contradicted claims refused: <count>` (runtime refusals with rule `claim.contradicts_facts`).
A percentage is rounded to a whole number with a `%`; "n/a" when the denominator is zero. These lines carry no pass/fail word.

**Settings.** `PUBLIC_PORT` (`publicPort`): whole number 0 or more, default 0 = no public listener. `PUBLIC_HOST` (`publicHost`): default `0.0.0.0`. `PUBLIC_BUYER_ALLOWLIST` (`publicBuyerAllowlist`): a set of lower-cased addresses read from a comma-separated list; blanks are dropped; an entry that is not a valid EVM address makes `loadConfig` throw; empty means any buyer. `loadConfig` throws when `PUBLIC_PORT` is above 0 and mainnet is allowed, and `startServer` repeats that refusal for a hand-built config, so the public listener cannot start on mainnet by either route. `.env.example` sets `PUBLIC_PORT=0`; both soak profiles set `PUBLIC_PORT=4748`; all three leave `PUBLIC_HOST` at the default and `PUBLIC_BUYER_ALLOWLIST` empty. The two soak profiles stay identical except `MONEY_MODE`.

**Public listener.** When `publicPort` is above 0, `startServer` opens a second listener on `(publicHost, publicPort)` after the main one, and `ServerHandle` gains `publicUrl` (set only then). The public listener classifies the path with the same agent-route classifier the main listener uses: a legacy (`/a/<id>`), index (`/a/<id>/`) or named (`/a/<id>/<name>`) route is served by the same code as on the main listener; a refused route answers 400 "Path is refused."; anything else answers 404 `{ "error": "Not found." }`, before any other route is considered. When the allow-list is not empty, both paid routes (the legacy single service and a named endpoint) check the payer's address after the payment is verified and before it is committed or a handler runs; a payer not on the list gets 403 `{ "error": "Buyer wallet is not allowlisted for this testnet test." }`, the held nonce is released, no money moves and no handler runs. The legacy route verifies, checks, commits and releases in the server rather than through the single settle call, because the check must sit between verify and commit. The main listener passes no allow-list, so its behaviour is unchanged. `close()` closes both listeners.

**Compose.** A new optional override file publishes only `"4748:4748"` on the orchestrator and carries no environment, no secrets and no defaults. The safe file is not touched. Compose appends the override's port to the safe file's loopback `4747` mapping, so the dashboard stays loopback-only when the override is added.

## Testing Decisions

A good test checks external behaviour through the existing seams: `Swarm.handleTool` for claims (result, `refusals` rows, `events`, ledger balance, `claims` rows); the written daily report for the new block; `loadConfig` for the new settings; real HTTP requests against a real `startServer` for the listeners; the env and compose files read as data, plus the existing key-parity tests. Real database and real swarm are used; only the handler sandbox is replaced by a counting stand-in (Docker is not available on Windows), so the tests can assert that a refused buyer never reached it.

New file `test/bo-4-3.test.ts` covers: "I earned $0.01", "I received a payment", "I was paid $0.50" refused with `claim.contradicts_facts`, a `refusals` row, a `claim_rejected` event and no fee, and no stored claim; an amount above the recorded income refused; "outside income" refused with only sibling income; accepted once income exists (and a smaller amount accepted); "earned $0", "no income", "my endpoint is not live" and "I will publish an endpoint" accepted; "Trail Runner 2 costs $89" and "I expect a buyer soon" accepted; the endpoint-live and test-delivery claims refused then accepted once the live endpoint row and the `code=ok` fact exist (and still refused with a failing delivery fact); the contradicted-claim rejection counting toward the hourly limit; the Stage 4 readiness block, with real numbers and with "n/a"; the Stage 3 block unchanged and directly above it; the three settings' defaults, parsing, rejection of malformed entries and the mainnet guard (in `loadConfig` and in `startServer`); the public listener serving `/a/<id>` and `/a/<id>/<name>`, answering 404 on the other paths and 400 on a refused path; the allow-list refusing a stranger with 403 and no settlement, no handler run and a released nonce, and serving an allowed buyer 200 (on both paid routes); `publicUrl` present and absent; both listeners closed; the three env files and the compose override.

Old expectations updated where this change touches them: the report fixture and `test/report-v2.test.ts` (new block), `test/refusals.test.ts` (rule list) and any other test the full suite shows asserting those lines or the claim behaviour. Prior art: `test/claims.test.ts` (claim tool through `handleTool`), `test/report-v2.test.ts` (fixture day), `test/nonce.test.ts` (real server with dry-run payments), `test/bo-4-2.test.ts` (settings and env files), `test/soak-profile-keys.test.ts` and `test/compose-config.test.ts` (env and compose parity).

## Out of Scope

No deploy; the Vultr server stays stopped. Base Sepolia testnet only; `ALLOW_MAINNET=false`. No TLS, no reverse proxy, no rate limiting beyond what exists, and no change to the main listener's routes. No "earn or perish" rule (Kevin has not confirmed it). No new tool, no new event kind and no new fee. The claim check does not try to verify any other kind of claim. No real wallet address, secret or SSH key in any file.

## Further Notes

Known pre-existing failures on this Windows checkout and on `main` (missing `turndown` in `senses`; `host-firewall` exit 127; `hands` and `nonce` `spawn EFTYPE` or 500 against 502; `app-wiring` EPERM on temp-dir cleanup; `raw-out` five-second timeout; `constitution` only under CRLF) are not touched. Because the check is wording-based, an agent can phrase a false claim in a way it does not catch; the Stage 4 report's `contradicted claims refused` line counts only what it did catch, and the ledger, the endpoints table and the test-delivery facts remain the source of truth.
