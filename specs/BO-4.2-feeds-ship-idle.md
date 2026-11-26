# BO-4.2 — Demand feeds first, ship one tested thing, and an idle/repeat-search brake

Spec for ORDER BO-4.2. Format: `to-spec` (mattpocock/skills). Lives in `repo/specs/` so the PR can cite it, same as earlier Automaton specs. Follows `BO-4.1-pacing-truncation-models.md`.

## Problem Statement

Stage 4 agents spend money on generic `web_search` queries, often the same query again and again, while the free demand feeds (`read_feed`) and the read-only `/ref` catalogs sit unused. Agents can also publish a static `offer_service` text with no test at all, so an offer can be on sale that nobody ever ran. And an agent with nothing productive to do keeps waking at the full turn rate and keeps paying for inference. Kevin wants agents to look at free demand signals first, to build and test one real paid endpoint before offering anything, and to slow down when they are idle or repeating themselves.

## Solution

Tell agents, in their prompts, to sample live demand feeds and the `/ref` catalogs before generic search, and to ship one tested endpoint (`write_file` a `handler.js`, then `serve_endpoint`) before more research when they have no live endpoint. Show `read_feed` use separately in the daily report. Add an owner switch that turns the static `offer_service` off (it is off in both soak profiles), and make the report's phantom-offers number count untested static offers as well as untested endpoints. Add an optional cooldown that refuses an identical `web_search` repeated by the same agent before any fee is charged. Add an optional idle brake that makes an agent's loop wait exponentially longer after a run of served turns that did nothing productive.

## User Stories

1. As Kevin, I want the agent's system prompt to tell it to try `read_feed` with `hn`, `x402-bazaar`, `rss` or `reddit` first, so it finds real demand before it guesses.
2. As Kevin, I want the prompt to point agents at `/ref/public-apis.md`, `/ref/datasets.rst` and `/ref/SOURCES.md` through `read_file`, so they use the free catalogs before paying for a search.
3. As Kevin, I want the prompt to say generic `web_search` comes after the feeds and the catalogs, so the cheap sources are read first.
4. As an agent with no live endpoint, I want the wake-up message to tell me to pick one concrete need, write `handler.js` and publish it with `serve_endpoint` before starting new research, so I build before I browse.
5. As an agent that already has a live endpoint, I want no such nudge, so the prompt stays short.
6. As Kevin, I want the agent snapshot to carry the count of the agent's live endpoints, so the wake-up message can tell the two cases apart.
7. As Kevin, I want the daily report's `Senses usage` line to show `feeds <n>` apart from `page views <n>`, so I can see whether agents are using the free feeds.
8. As Kevin, I want that line in the exact form `searches <n>, feeds <n>, page views <n>, browse calls <n>, cost $<usd>`, so it can be read and compared the same way each day.
9. As Kevin, I want an `ALLOW_OFFER_SERVICE` switch, default on, so every existing unit test and non-soak setup keeps working.
10. As Kevin, I want `ALLOW_OFFER_SERVICE=false` in `.env.example` and in both soak profiles, so a soak agent cannot publish an untested static offer.
11. As an agent, I want a refused `offer_service` to say what to do instead (write `handler.js` and test-publish a paid endpoint with `serve_endpoint`), so I can recover.
12. As Kevin, I want that refusal to happen before any fee is charged, with rule `tool.disabled`, so a disabled tool costs nothing.
13. As Kevin, I want the tool description for `offer_service` to say it is a static, untested offer and to point at `serve_endpoint`, so models choose the tested path.
14. As Kevin, I want the report's phantom-offers number to count every live endpoint without a passing test delivery and every static service without a passing test delivery for `_service`, so an untested static offer cannot hide.
15. As Kevin, I want an optional `REPEAT_SEARCH_COOLDOWN_MS` (default 0, off), so existing tests that repeat a search keep passing.
16. As Kevin, I want the soak profiles to set it to six hours and `.env.example` to set it to 0.
17. As Kevin, I want a repeated `web_search` (same normalized query, a successful earlier search inside the cooldown) refused before any fee, with rule `limit.repeat_search`, so duplicate searches stop costing money.
18. As an agent, I want the repeat-search refusal to tell me to read a demand feed, inspect `/ref`, or build with `write_file` and `serve_endpoint`, so I know the better next step.
19. As an agent, I want a different query, or the same query after I published an endpoint or page since the earlier search, to be allowed, so the brake does not block real progress.
20. As Kevin, I want queries normalized (lower case, whitespace collapsed, trimmed) before the comparison, so trivial rewording does not dodge the brake.
21. As Kevin, I want an optional `IDLE_BRAKE_TURNS` (integer 0 or more, default 0 = off), so existing loop tests keep their timing.
22. As Kevin, I want the soak profiles to set it to 3 and `.env.example` to 0.
23. As Kevin, I want the Docker runtime to pass `IDLE_BRAKE_TURNS` into each agent container, and the container entry point to pass it into the loop, so the brake works inside containers.
24. As Kevin, I want a served turn that ran none of `write_file`, `shell`, `serve_endpoint`, `publish_page`, `read_feed` (or only refused calls to them) to count as idle, so an agent that only thinks, searches or sleeps is slowed.
25. As Kevin, I want the wait after an idle streak of at least `IDLE_BRAKE_TURNS` to double for each further idle turn, up to eight times the normal turn interval, so cost falls without the agent going dark.
26. As Kevin, I want one productive turn to reset the streak and the normal wait, so an agent that starts building is back at full speed.
27. As Kevin, I want a skipped inference (spend cap, model failure), a kill-switch turn and a failed turn to leave the idle streak unchanged, so only real served turns count.
28. As Kevin, I want a spend-cap `retryAfterMs` to keep priority over the brake, so BO-4.1 pacing is unchanged.
29. As Kevin, I want the long wait to still end at once on abort, so the kill switch and shutdown stay prompt.
30. As Kevin, I want every new setting declared in `.env.example` and in both soak profiles, with both profiles identical except `MONEY_MODE`, so the profile-key and compose tests stay green.

## Implementation Decisions

**Prompts.** The system prompt gains one short "discovery order" paragraph: sample live demand with `read_feed` (sources `hn`, `x402-bazaar`, `rss`, `reddit`), then read `/ref/public-apis.md`, `/ref/datasets.rst` and `/ref/SOURCES.md` with `read_file`, then use `web_search` only for what those did not answer. The wake-up message adds a ship-one-thing cue only when the snapshot's live-endpoint count is exactly 0 (unset counts as unknown and gets no cue). The cue names the steps: pick one concrete need, `write_file` a `handler.js`, publish it with `serve_endpoint`, and do that before new research.

**Snapshot.** `AgentSnapshot` gains an optional `liveEndpoints` number. `Swarm.snapshot` fills it with the count of the agent's endpoints that are live (status `live` or unset). A live endpoint has already passed the test run at publish time, so live means passing for this cue.

**Report.** `read_feed` moves out of the page-view tool list into its own feed list. The `Senses usage` per-agent line is `searches <n>, feeds <n>, page views <n>, browse calls <n>, cost <usd>`. Feeds are counted from evidence rows like the other columns.

**Offer switch.** `AppConfig.allowOfferService` from `ALLOW_OFFER_SERVICE`: unset or empty means true; the text `true` is true; any other value is false (fail closed when the owner wrote something). In the `offer_service` handler, when the switch is false the call is refused first, before the constitution review and before any fee, with rule `tool.disabled` and the reason `Static offer_service is disabled; write handler.js and test-publish a paid endpoint with serve_endpoint instead.` The refusal also writes an `offer_service` event with `outcome=refused cost=0`, so the report's offers section counts it as refused, like the other offer refusals. The refusals table row is written by the single existing write point. `.env.example`, the soak template and the Sepolia profile set `false`; the config default stays `true`.

**Phantom offers.** The count is: live endpoints whose latest `test_delivery` fact (subject = endpoint name) is missing or not passing, plus services rows with no passing `test_delivery` fact whose subject is `_service`. No code writes a `_service` fact today, so every static service row counts, which is the point: a static offer has never been run.

**Repeat-search cooldown.** `AppConfig.repeatSearchCooldownMs` from `REPEAT_SEARCH_COOLDOWN_MS`, integer 0 or more, default 0 (off); soak profiles 21600000 (six hours), `.env.example` 0. New rule id `limit.repeat_search`. The search query is normalized as lower case, whitespace runs collapsed to one space, trimmed. The evidence row for a `web_search` stores the input hash of the normalized query (the one place that hash is computed is shared by the writer and the check), so the check compares like with like. When the cooldown is above 0, `webSearch` refuses before the fee if the agent has an evidence row for `web_search` with status `ok` and the same hash created within the cooldown, unless the agent has since had a successful `serve_endpoint` or `publish_page` (an event with `outcome=ok` after that evidence row). The refusal reason tells the agent to use `read_feed`, inspect `/ref`, or build with `write_file` and `serve_endpoint`. A refused search still writes its usual refused evidence row and a refusals row; it never counts as an earlier successful search.

**Idle brake.** `AppConfig.idleBrakeTurns` from `IDLE_BRAKE_TURNS`, integer 0 or more, default 0 (off); soak profiles 3, `.env.example` 0. `DockerRuntime.start` adds `-e IDLE_BRAKE_TURNS=<value>`. The container entry point reads `process.env.IDLE_BRAKE_TURNS` and passes `idleBrakeTurns` to `runAgentLoop`; the in-process path in the app passes the config value. In `runAgentLoop`: a turn is "served" when inference ran (not skipped, not kill-switch/not-running, not an exception). A served turn is "productive" when at least one call to `write_file`, `shell`, `serve_endpoint`, `publish_page` or `read_feed` was not refused. Productive resets the idle streak to 0; a served non-productive turn adds 1; other turns leave it unchanged. When `idleBrakeTurns > 0` and the streak is at least `idleBrakeTurns`, the next wait is `sleepMs * 2^(streak - idleBrakeTurns + 1)`, never more than `8 * sleepMs` (40 minutes at five-minute turns). A spend-cap `retryAfterMs` still wins. The loop's sleep function is injectable (default: the existing abortable sleep) so the wait can be asserted without real timers; abort still ends any wait at once.

**Env declarations.** Every new name (`ALLOW_OFFER_SERVICE`, `REPEAT_SEARCH_COOLDOWN_MS`, `IDLE_BRAKE_TURNS`) is declared in `.env.example` and in both soak profiles, which stay identical except `MONEY_MODE`.

## Testing Decisions

A good test here checks external behaviour through the existing seams, not helper internals: `buildSystemPrompt` and `buildWakeup` text; the written daily report; `Swarm.handleTool` results, the refusals table and the ledger; `DockerRuntime.start` arguments; `runAgentLoop` waits through a fake host and an injected sleep; the env files through `loadEnvFile`/`loadConfig`.

New file `test/bo-4-2.test.ts` covers: the feed/`/ref`/ship-one cues; `feeds <n>` apart from `page views <n>`; `ALLOW_OFFER_SERVICE=false` refusing with `tool.disabled` and charging nothing; the allowed default; `phantomOffers` counting an untested services row (and a services row does not hide behind a passing endpoint); `REPEAT_SEARCH_COOLDOWN_MS` refusing a normalized duplicate before the fee with `limit.repeat_search`, allowing a distinct query, allowing the repeat after a shipped endpoint, after the cooldown, and doing nothing when 0; `IDLE_BRAKE_TURNS` forwarded by `DockerRuntime.start`; the loop backing off on idle turns up to the cap, resetting after `write_file`, `serve_endpoint` or `read_feed`, ignoring refused productive calls and skipped turns, and staying off when 0; the three env files carrying the new keys with the intended values.

Old expectations updated where this change touches them: the report fixture and `test/report-v2.test.ts` (the `Senses usage` format, and the phantom-offers line, because the fixture day publishes a static offer), plus any other test the full suite shows asserting those lines. Prior art: `test/bo-4-1.test.ts` (Docker args, loop retry), `test/report-v2.test.ts` (fixture day), `test/refusals.test.ts` (rule ids), `test/soak-profile-keys.test.ts` (env files).

## Out of Scope

No deploy; the Vultr server stays stopped. No mainnet; Base Sepolia testnet only. No new endpoint or tool beyond the three refusal/brake rules above. No change to `read_feed`, its price, or its hourly limit. No change to the hourly spend cap or the daily cap from BO-4.1. No ranking of agents. No change to what `serve_endpoint` tests.

## Further Notes

Known pre-existing failures on this Windows checkout and on `main` (missing `turndown` in `senses`; `host-firewall` exit 127; `hands` and `nonce` `spawn EFTYPE`; `app-wiring` EPERM on temp-dir cleanup; `raw-out` five-second timeout) are not touched. `ALLOW_OFFER_SERVICE=false` in `.env.example` while the code default is `true` is deliberate: the example file shows the soak-safe value, the code default keeps older tests and setups working.
