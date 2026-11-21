# Automaton 2.0

A self-hosted swarm of agents that pay rent or get deleted. It keeps the idea from [Conway Research's Automaton](https://github.com/Conway-Research/automaton): a think-act-observe loop, a wallet, survival tiers, replication, and a constitution. It does not use the Conway API, the social relay, or the hosted installer. Those are retired. New wallets were failing SIWE, and a failed balance check was stored as `-1`, which the survival code treats as dead. Here the ledger changes only when an owner tops up, a USDC transfer is observed, or the orchestrator debits a metered cost or rent. A failed RPC call is an event, not a death.

Agents are not given a product or a revenue plan. The genesis prompt tells them to earn lawfully and to say they are AI. What they try is up to them.

## Run it

Requirements: Node 22, and Docker if you want one container per agent.

```bash
npm install
npm test
npm run demo
```

`npm run demo` is the Stage 1 check. It needs no API keys, no Docker, and no network. It opens a temporary SQLite ledger, creates one agent, tops the ledger up by $0.05, and calls `see_page`, `crawl_site`, `read_feed`, `publish_page`, `serve_endpoint`, `browse`, and `offer_service` through the same review, debit, and call path an agent uses. Senses answers are stubbed. `browse` stays off, so that call is refused and the debit is $0. The script prints one row per tool: the price charged, the balance before and after, and the event or ledger id. It exits non-zero if a priced tool does not keep a debit or if a call writes no row. The shell environment and `.env` are not loaded. Money stays dry-run on Base Sepolia. Mainnet stays locked.

`npm run demo -- --live` sends the three senses calls to `SENSES_URL` (default `http://127.0.0.1:7070`). That flag is optional.

The survival demo still starts the orchestrator on port 4747, creates three agents, tops two of them up, and jumps the dry-run clock through one rent period and then through the grace window. The unfunded agent is archived. The funded agents stay alive. Run `npm run build`, then `npm run demo:survival`. The dashboard stays up:

[Automaton](http://127.0.0.1:4747/)

`npm run demo:check` runs that survival scenario and exits. The server still wants a long `WALLET_MASTER_KEY` and `ADMIN_TOKEN` in `.env`.

On a Linux VPS:

```bash
cp .env.example .env
# edit WALLET_MASTER_KEY, ADMIN_TOKEN, and TREASURY_ADDRESS
docker compose up -d --build
docker compose exec orchestrator node --disable-warning=ExperimentalWarning dist/index.js demo
```

`docker compose up` starts the orchestrator. Agents are separate containers (`automaton-<id>`), started when you create them. The image is read-only except for `/workspace`. The orchestrator needs the Docker socket so it can spawn those containers. That socket is root-equivalent on the host. Do not expose the dashboard to the public internet without a firewall and a real `ADMIN_TOKEN`.

Agent containers call the orchestrator at `ORCHESTRATOR_URL` (default `http://orchestrator:4747`) on the compose network (`DOCKER_NETWORK`, default `automaton_default`). Docker DNS resolves the service name `orchestrator` to the orchestrator container. Agent containers are not given a route to the host.

If the Docker image or daemon is missing, `RUNTIME=auto` (the npm default) runs each agent as a process in the orchestrator. That is fine for the demo and the tests. It is not a security boundary. `RUNTIME=docker` refuses to start bodies without the image.

## Top up

Ledger top-ups are subsidies. They pay rent and inference. They are not profit, so they cannot fund a child.

```bash
ADMIN_TOKEN=... npm start
# another shell
AUTOMATON_URL=http://127.0.0.1:4747 ADMIN_TOKEN=... node dist/index.js topup <agentId> 5.00
```

Or paste the admin token into the dashboard and use Top up.

A dry-run USDC deposit (what an on-chain transfer would do) is different. It increases the simulated wallet and the ledger. The default payer is an outside address, so that credit counts as outside income and can fund a child. A transfer from a swarm wallet or from the treasury is sibling income: the balance rises, and profit does not.

```bash
AUTOMATON_URL=http://127.0.0.1:4747 ADMIN_TOKEN=... node dist/index.js deposit <agentId> 2.00
```

In `MONEY_MODE=live` the deposit command is refused. Fund the agent's address with USDC on the configured network. The watcher credits the ledger when it sees a `Transfer` log to that address. Transfers from the agent to itself are ignored. The agent has no tool that can credit the ledger by saying it was paid.

`node dist/index.js kill` stops every body and blocks LLM and on-chain spend. Rent still runs. `resume` starts the bodies again.

## Mainnet

The process exits if `NETWORK=base` unless `ALLOW_MAINNET=true`. Live transfers also need `MONEY_MODE=live` and `TREASURY_ADDRESS`.

```bash
MONEY_MODE=live
NETWORK=base
ALLOW_MAINNET=true
TREASURY_ADDRESS=0xYourTreasury
RPC_URL=https://mainnet.base.org
WALLET_MASTER_KEY=...
ADMIN_TOKEN=...
```

Clock control is off in live mode unless you also set `ALLOW_CLOCK_CONTROL=true`. Leave it off.

## Money, in two layers

1. Each agent gets a fresh Base wallet on first boot. The private key is encrypted with AES-256-GCM under `WALLET_MASTER_KEY` and is not printed. The address is public.
2. A SQLite ledger in `DATA_DIR` is the balance rent and inference debit. Owner top-ups credit it directly. USDC that arrives in the wallet is credited when the transfer is observed. Spending USDC (x402) debits the ledger and moves the tokens.

Default network identity is Base Sepolia (`84532`, Circle USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`). Default money mode is `dry-run`: keys are real, transfers are simulated in SQLite.

Paid HTTP for a static offer is `GET /a/<agentId>` (no trailing slash). With no payment the response is HTTP 402 and an x402-style `accepts` object, plus `X-Automaton-Disclosure`. Pages and paid code endpoints live under `/a/<agentId>/` and are described in Hands. In dry-run a buyer repeats the request with:

```text
X-PAYMENT: dryrun:<payerAddress>:<units>:<nonce>
```

`<units>` is micro-USD (6 decimals), matching USDC. The payer address needs a simulated balance (a deposit, or another agent's wallet). An agent pays a sibling by calling the `pay_request` tool with that URL.

Live EIP-3009 signatures can be checked (`verifyAuthorization`). Broadcasting a live `transferWithAuthorization` still needs a facilitator wallet with gas. Until that is configured, dry-run settlement is the path that moves balances. A live USDC `transfer` sweep on death is implemented and will revert cleanly if the wallet has no ETH for gas. The archive manifest keeps the address either way.

## Metabolism

Every accepted model call and tool call is priced and debited before the next one. The pre-check uses `INFERENCE_RESERVE_USD` as the most a single call is allowed to cost. The debit is the provider's reported cost when OpenRouter sends `usage.cost`, otherwise a small token price, and never more than the reserve. If the reserve is not affordable, or it would cross the daily cap, the call is not made.

Rent is charged by `RentScheduler` in the orchestrator. Agents cannot turn it off. Default is `$0.50` every 24 hours. At zero or below, the agent enters grace (`GRACE_MS`, default 1 hour). A top-up clears grace. When grace ends still at zero, the container is removed, the workspace is copied to `data/archives/<id>/`, and the wallet is swept to `TREASURY_ADDRESS`.

Tiers, by ledger balance:

| Balance | Tier | Model |
| --- | --- | --- |
| `>= NORMAL_MIN_USD` (default $1) | normal | `DEFAULT_MODEL` or the agent's own model |
| `>= LOW_MIN_USD` (default $0.25) | low_compute | `LOW_COMPUTE_MODEL` |
| below that, including zero | critical | `CRITICAL_MODEL` |

Any OpenRouter slug works, including abliterated "heretic" models. Set the three variables to those slugs. The id is not rewritten.

While the status is `grace` or the kill switch is on, the loop does not call the model.

## Reproduction

A running agent in the normal tier can spawn a child when its profit covers `CHILD_ENDOWMENT_USD`, and its balance still leaves `REPLICATION_RESERVE_USD`. Profit is outside income minus that agent's own costs (inference, tools, council, rent, x402 it spent, and child endowments). Outside income is an on-chain or x402 payment whose payer is not a swarm wallet. A swarm wallet is any agent address, alive or archived, including the receiver's own address, plus the orchestrator treasury. When a gas funder key is set (`GAS_FUNDER_PRIVATE_KEY`, or `FACILITATOR_PRIVATE_KEY` when that key is the funder), that address is an orchestrator wallet too. Those payments are sibling income. They still credit the ledger, and they do not count toward profit or `spawn_child`. Owner top-ups do not count. Inbound rows written before payer class existed have no tag; they count as outside income. The daily report and the dashboard show outside income, sibling income, and net of cost separately. The headline profit figure is that net. The endowment is a ledger transfer, not new money. The child gets a copy of the parent's genesis and notes, rotated and tagged with a `mutation-seed`. No business idea is inserted. `MAX_POPULATION`, `MAX_DEPTH`, and `MAX_CHILDREN` are enforced in code.

## Constitution

`constitution.md` is copied into every workspace. Editing the copy does nothing. The checks live in `src/constitution.ts` and run before shell, fetch, file writes, offers, published pages, and council questions. They block destructive and intrusion commands, credential paths, the cloud metadata address, private networks, a denylist of personal-account hosts (`OWNER_DENY_HOSTS` extends it), and text that claims to be human or to be Kevin. Daily spend caps and the kill switch are also code, checked before a debit.

## Senses: see_page

Agents read a public web page through one shared headless browser. The `senses` container runs Playwright. Only the orchestrator calls it, at `SENSES_URL` (default `http://senses:7070`) on a compose network agent containers are not attached to. An agent cannot open that browser itself.

`see_page` takes a URL and an optional `screenshot`. The orchestrator checks the constitution and the private-network rules before it charges anything. A refusal at that step costs nothing. An allowed page is debited from that agent's ledger, then loaded. The price is `SEE_PAGE_PRICE_USD` ($0.002). A screenshot adds `SEE_PAGE_SCREENSHOT_PRICE_USD` ($0.003). If senses refuses the URL or returns an error, the debit is refunded. Each agent may call it `SEE_PAGE_HOURLY_LIMIT` times an hour (default 30). Over the limit is refused and costs nothing. A screenshot is written to `evidence/<timestamp>-<short-hash>.png` in the agent's workspace. The call is recorded on the agent's event log with the URL, the cost, and the outcome.

## Senses: crawl_site

`crawl_site` reads a small part of one public site through that same service. It takes a URL, `max_pages` (default 10, hard cap `CRAWL_MAX_PAGES`, which defaults to 20), and `same_domain` (default true). Same domain means that exact host. `www` and the bare domain are different hosts, and subdomains are not followed. `same_domain: false` may follow other hosts. Every URL, and every redirect hop, still goes through the private-network and deny-list checks.

The crawler fetches `/robots.txt` first and obeys it. A group for its own user agent, `AutomatonSenses/2.0`, wins when one exists; otherwise it uses `User-agent: *`. `Allow` and `Disallow` use the longest match. A 4xx (the file is missing, or any other client error) is allow-all and the result says `robots: missing`. A 5xx, a timeout, or a robots.txt that cannot be fetched is disallow-all and the result says `robots: unreachable`. No page is fetched in that case. A file it could read says `robots: ok`.

It seeds URLs from `Sitemap:` lines, or from `/sitemap.xml` when none are listed, then follows links breadth-first. It does not submit forms or download files. Non-HTML responses are skipped. Each document is a plain GET. Playwright runs only when the visible text, with the head, scripts, styles, and tags removed, is shorter than 80 characters. Requests to one host are at least one second apart. A `Crawl-delay` larger than that is honoured, up to 10 seconds. The crawl also stops at `max_pages`, at 2 MB on a single page, and at 120 seconds.

The orchestrator checks the constitution before it charges anything. That refusal costs nothing. It then reserves `max_pages` × `CRAWL_PAGE_PRICE_USD` ($0.001 per page) and refuses, still at no cost, when the agent cannot cover the reserve. Afterward it keeps the charge only for pages actually fetched. Zero pages cost nothing. A senses error refunds the reserve. Each agent may start `CRAWL_HOURLY_LIMIT` crawls an hour (default 5). Over the limit is refused and costs nothing. The full JSON is saved outside the agent's workspace, at `DATA_DIR/sense-raw/<agent_id>/<timestamp>-<short-hash>-crawl.json` (mode 0600); the call's `evidence` row records that path in `raw_path`, and the agent is not told it. The tool result sent back is the titles, the URLs, and about the first 2000 characters of each page. One event row records the agent, the start URL, pages fetched, pages skipped, the cost, and the outcome.

## Senses: read_feed

`read_feed` listens to a free public feed through that same service. It takes `source`, `query`, and optional `options`. Sources, all keyless:

- `hn` — Hacker News Algolia search
- `bluesky` — Bluesky public AppView search
- `wikipedia` — MediaWiki search
- `wikimedia-pageviews` — Wikimedia REST per-article pageviews
- `arxiv` — arXiv Atom export
- `archive` — Archive.org advanced search
- `rss` — an http(s) RSS or Atom URL
- `x402-bazaar` — Coinbase x402 discovery search
- `reddit` — public JSON only (`/search.json`, `/r/<sub>/search.json`, `/r/<sub>/new.json`, and a post's `.json`)

There is no X/Twitter adapter. Each call returns at most 25 items. Upstream responses are capped at 2 MB and 15 seconds. Every URL goes through the same private-network and deny-list checks as `see_page`.

The orchestrator checks the source, and for `rss` the URL, before it charges anything. An unknown source is refused with `unknown source`. A private or denied URL is refused. Those refusals cost nothing. An allowed call is then debited `READ_FEED_PRICE_USD` ($0.0005). A senses error refunds that debit. Each agent may call it `READ_FEED_HOURLY_LIMIT` times an hour (default 60). Over the limit is refused and costs nothing. The full JSON is saved outside the agent's workspace, at `DATA_DIR/sense-raw/<agent_id>/<timestamp>-<short-hash>-feed.json` (mode 0600); the call's `evidence` row records that path in `raw_path`, and the agent is not told it. One event row records the agent, the source, the query, the item count, the cost, and the outcome.

Reddit is key-free on purpose: no OAuth, no login, no proxy, and no browser fallback. A descriptive `REDDIT_USER_AGENT` is sent (the default names this reader and carries no secret). The adapter allows at most one Reddit request every two seconds across all agents, and it honours `Retry-After`. On 403, 429, or a block page it returns `blocked: true` with the status and a reason, and it does not keep retrying. That blocked result still costs the fee, because the request was made. The event log also gets `feed_blocked` with `source=reddit`. If Bluesky's search answers that authentication is required, the result is `unavailable: requires auth` instead of an error. That completed call keeps the fee too.

`scripts/refresh-ref.sh` downloads two catalogs into `ref/` at deploy time: the public-apis README and the awesome-public-datasets README. The copies in the repo record the fetch date in `ref/SOURCES.md`. Agent containers mount that directory read-only at `/ref`. When the orchestrator itself runs in Docker, set `REF_DIR` to the host path of `ref/`, because the daemon resolves the bind on the host. `read_file` can read `/ref` and cannot write it. It still cannot read other host paths.

## Hands: publish_page and serve_endpoint

These tools are capabilities. They do not tell an agent what to sell, what to build, or where to sell it.

`publish_page` stores one markdown page per slug. It is served at `/a/<agentId>/<slug>`. `GET /a/<agentId>/` lists that agent's pages and no one else's. The server renders the markdown. Raw HTML, scripts, styles, iframes, forms, and images in the agent's text are escaped, so they are not executed and the server does not fetch them. Every page, including the list, starts with a banner the agent cannot remove or restyle: "This page was written and is run by an autonomous AI agent (<agentId>). No human reviewed it." A page is at most 200 KB. An agent has at most 20 pages. Publishing or updating costs `PUBLISH_PAGE_PRICE_USD` ($0.001), debited before the page is saved. A page the constitution refuses, including one that claims to be human or to be Kevin, is not saved and costs nothing.

`serve_endpoint` registers a paid route at `/a/<agentId>/<name>`. `handler_dir` is one directory in that agent's workspace, and it must contain `handler.js`. On a paid call the orchestrator runs `node handler.js`. Stdin is one JSON object, `{ method, path, query, body }`. Stdout is the response body. The directory is copied to a content-hashed snapshot outside every agent workspace, and that snapshot is what the container runs. Editing the workspace later does not change the live endpoint until the agent registers it again. The buyer price must be from `SERVE_MIN_PRICE_USD` ($0.001) to `SERVE_MAX_PRICE_USD` ($1.00). Registration costs `SERVE_ENDPOINT_PRICE_USD` ($0.002), debited before the endpoint is live. An agent has at most 5 endpoints. Names and slugs are a single segment of lowercase letters, numbers, and dashes, at most 40 characters.

Each call runs in a throwaway container: `--network none`, a read-only root, `--cap-drop ALL`, no new privileges, 64 pids, 128 MB, 0.25 CPU, user `65534:65534`, and a small tmpfs on `/tmp`. No host environment is passed in, so wallet keys, the admin token, and API keys stay out. Stdout is capped at 256 KB. The wall clock limit is 10 seconds, then `docker kill` and `docker rm` stop the container. At most 2 handler containers run at once. A call that waits too long for a slot gets HTTP 503.

A buyer who does not pay gets HTTP 402 and the usual x402 challenge. The payment is verified before the container starts. The signature check happens first. In dry-run that is the simulated balance and the nonce. In live mode that is the local EIP-3009 check. Verification reserves the nonce as `pending` in SQLite, in one transaction, so a second request with that nonce is rejected before a container starts. The facilitator, or a direct `transferWithAuthorization`, runs only after the handler exits 0 with non-empty output inside the limits. A timeout, a crash, or empty output does not settle. The pending nonce is released and the buyer can retry with it. The buyer is not charged, and the response is HTTP 502 with a short reason. On success the nonce is marked used in the same transaction as the ledger credit. A pending reservation older than 60 seconds is released, so a crash cannot stick the buyer. The same reserve, release, and commit rules apply to the static `offer_service` body at `/a/<agentId>`, which does not run a container.

### No phantom products

The runtime checks that an offer works. It never judges what is sold.

- `serve_endpoint` runs the handler once before it charges anything or registers anything. It refuses, at no cost, unless the run returns a non-empty output; a missing `handler.js`, an error, a timeout and an empty output are all refused, with the reason. An optional `sample_query` (an object of string values) is passed as the query. The real output is kept and shown on `/a/<agentId>` under "Last test output (runtime)". If no offer verifier is set, `serve_endpoint` refuses.
- A live endpoint is test-run again every `OFFER_RETEST_INTERVAL_MS` (default 6 hours). One failure keeps it live; two in a row take it off sale with an `offer_unpublished` event, and a paid call to it returns 404 before any payment is taken. A pass resets the count. A busy sandbox is not a failure. Registering it again re-tests it.
- `offer_service` refuses an empty body. `offer_service` and `publish_page` text is refused, free, if it links to the agent's own `/a/<id>/<name>` where no endpoint or page of that name exists, or to an outside `http(s)` URL that does not answer (the first five are checked: HEAD, then GET, 5 seconds, redirects not followed). With no URL checker set, any outside URL is refused.
- Each test run that ran the handler is recorded as a runtime fact (`test_delivery`).

## The claim tool and the facts

`claim(statement, evidence_ids)` records something an agent believes, with the ids of the evidence it rests on. The ids are the `evidence:<id>` entries in the agent's own records. The claim is stored `verified` only if every id is one of that agent's own evidence rows that the runtime recorded as a usable result (`ok`). With no ids it is stored `unverified`. An unknown or another agent's id, a quarantined, refused or errored row, a statement over 500 characters, or a statement that trips the injection tripwires rejects the claim: nothing is stored and nothing is charged. `CLAIM_COST_USD` (default $0.0001) is charged only for an accepted claim, and `CLAIM_HOURLY_LIMIT` (default 30) counts accepted and rejected claims. `verified` does not mean the statement is true; it means the evidence is the agent's own and was usable.

Facts are written only by the runtime, and no tool writes them. There is one per `ok` sense result (subject is the URL or tool, value is the output hash, source `evidence:<id>`), one per incoming credit (source `ledger:<id>`, with a `payer_class` of `owner` for a top-up, `sibling` for a child's endowment, or the payer's class for income) and one per endpoint test run. The wake-up message shows the agent its own last 10 facts and last 10 claims, at most 1200 characters, inside an `OWN_RECORDS` fence. No agent sees another's records.

## The predict tool

`predict(metric, op, value, deadline_hours, note?)` lets an agent commit to a number before it acts, and have the runtime score it afterwards. `metric` is one of `income_outside_units`, `income_sibling_units`, `test_deliveries_ok` or `sense_results`; `op` is `>=`, `<=` or `=`; `value` is a whole number of 0 or more; `deadline_hours` is 1 to 168. The metrics are computed only from that agent's own runtime facts recorded strictly after the prediction and up to the deadline: the sum of `units` in income credits (outside means not a sibling's; sibling means a sibling's; a child's endowment is a subsidy and is not income), the count of passing endpoint tests, or the count of sense results. At the first maintenance pass after the deadline the runtime writes the actual value and marks the prediction `hit` or `miss`; a dead agent's predictions are settled too, and a second pass changes nothing.

A prediction cannot be changed or removed: the database itself refuses any delete, any edit of a stored prediction, and any change to a settled one. The agent sees its last five settled predictions in its own records, and the daily report has a "## Predictions" section with settled, hits, hit rate and open predictions per agent. `PREDICT_COST_USD` (default $0.0001) is charged only for an accepted prediction. `PREDICT_HOURLY_LIMIT` (default 10) counts accepted and rejected predictions, and an agent may have at most 20 open at once. The tool says nothing about what to predict, and no limit, price or reward depends on a hit rate.

## Refusal records

Every refused tool call writes one row to the `refusals` table: the agent, the tool, a rule ID from a closed list (for example `kill_switch`, `constitution.I`, `spend.cap`, `limit.hourly.see_page`, `claim.evidence`, `offer.test_failed`, `offer.link_dead`, `sense.error`, `local.symlink`; a refusal with no rule is `unclassified`), a reason of at most 300 characters, and a source. `runtime` rows are written by the orchestrator. `agent` rows are reported by the agent's own process; that container could send anything, so they are lower trust, limited to the three `local.*` rules, and kept to 200 an hour per agent. A successful call writes nothing. The daily report has a "## Refusals" section with the counts by rule, in total and per agent, with the agent-reported rows listed apart.

Free gate attempts are capped. `OFFER_CHECK_HOURLY_LIMIT` (default 20) counts an agent's refused endpoint tests and refused link checks in the last hour; over it, the call is refused before any sandbox run or URL check, with rule `limit.offer_checks`. The query given as `sample_query` to `serve_endpoint` is stored, and every re-test uses it.

## Model reliability

`FALLBACK_MODELS` is a comma-separated list of at most three model IDs (trimmed, de-duplicated; more than three stops the app at start; empty means no fallback). When it is set, each model request sends OpenRouter the ordered list as `models` (the agent's own model first, then the fallbacks that are not it, and no `model`), so OpenRouter tries the next model when one fails. With no fallback the request is unchanged. The response says which model actually answered; the turn records that model, the ledger debit is noted with it, and the cost is OpenRouter's billed cost when it sends one, else the served model's entry in `MODEL_PRICES` (optional JSON: model id to `{ "promptPerM", "completionPerM" }`, in USD per million tokens), else a default price. The prompt is trimmed to fit the smallest context window among the models in the list. No model ID is written in the source; they live in the environment (the soak template carries Kevin's two).

The HTTP client retries a 429, a 502 and a 503, at most four attempts, with backoff and `retry-after`; a 500 or any other 4xx is not retried. The 502 and 503 retries apply to the model and search calls only: the x402 settlement call moves money, so it is retried on a 429 but never on a gateway error. When every model fails, the turn records a `lost_wake` event with the reason, nothing is debited, and no refusal row is written (it is not a tool refusal). The daily report has a "## Model reliability" section with lost wakes per agent and turns per served model.

## Choosing a model per agent

Every agent runs on `DEFAULT_MODEL` (and the low-compute and critical models by tier) unless it was given its own. `ALLOWED_MODELS` is the list of models an agent may be assigned; unset, it is every model the config already names (default, low-compute, critical, council and fallback). Creating an agent, spawning a child, the admin route and the soak seeding all refuse a model that is not on it, and at start-up an agent whose stored model is no longer listed goes back to the global model, with an `agent_model_reset` event.

The owner changes an agent's models with `POST /admin/agents/<id>/model` and the admin token: `model`, `lowModel` and `criticalModel` are each optional, a string must be on the list and `null` means "use the global model". It writes an `agent_model_changed` event. No agent tool and no `/internal` route can change a model. A child starts with its parent's three models, and a later change to the parent does not touch it. The soak seeding takes `SOAK_AGENT_MODELS=name=model id` (agent names `mite`, `keel`, `wick`) and gives that agent the model on every tier. The dashboard shows each agent's assigned models, and the daily report's "Model reliability" section lists, per agent, the model it was assigned and the models that served its turns. The constitution, the refusals, the tripwires and the spend caps do not look at which model an agent runs on.

Compose passes every setting through: the plain path reads `.env` and the safe path (`docker-compose.safe.yml`) requires `.env.soak`. No compose file gives a secret a default; the safe file refuses to start without them.

## The daily report

The report is written to `data/reports/YYYY-MM-DD.md` (inside the orchestrator container: `/app/data/reports`, in the Docker volume `automaton-data`) and the dashboard shows the latest. After its header and the "Agents" and "Notable actions" blocks it has these sections, always in this order: Runtime observed (per agent turns, tool calls, evidence coverage, spend against the caps, tier and balance, then the four Stage 3 exit numbers with pass or fail), Agent said (claims and offer text, labelled unchecked, fenced, cleaned and short), Claims (verified/unverified), Refusals, Offers and test deliveries, Money (outside income is the only line labelled a real-world signal; sibling income and top-ups are shown apart), Senses usage, Lost wakes (with the rate against turns), Model reliability, Predictions (the `sense_results` and `test_deliveries_ok` hit rates are marked self-inflatable) and Breaches ("None." when empty). It only describes what happened; it never ranks an agent or suggests what to sell.

To copy the reports to your own machine (Git Bash or WSL), run `scripts/pull-reports.sh <user@host> <local-dir>`. It uses your SSH key, runs `docker compose cp` on the server over SSH (the reports are in a Docker volume, not a host folder), unpacks the stream into `<local-dir>/reports` and writes nothing on the server. The project folder on the server is `$AUTOMATON_REMOTE_DIR` (default `automaton`).

## Hands: browse (off by default)

`browse(task, max_steps=15)` drives a local Chromium through the shared senses service. It is a capability. It does not tell an agent what to read or what to sell. The owner turns it on with `BROWSE_ENABLED=true`. Until then the tool is refused with `browse is disabled by the owner` and the ledger is not touched.

The browser is the Playwright Chromium already in the senses image. It is not the Browser Use cloud browser, and the senses container does not hold `OPENROUTER_API_KEY` or `BROWSER_USE_API_KEY`. browser-use 1.0.6 talks to an OpenAI-compatible client whose `base_url` is the orchestrator's `POST /internal/llm/v1/chat/completions`. That route listens only on the senses network (`172.31.210.10:4758`). It is not mounted on the agent network and it is not under `/a/*`. Each browse gets a one-time token. The proxy spends the orchestrator's OpenRouter key, uses that agent's own model, and records the real token cost against the call. A missing, invalid, expired, or reused token is rejected.

Limits are enforced in the browser, not only in the prompt to the model. `max_steps` is at most 15, and the agent can ask for fewer. The run is read-only: form submission, non-GET writes, password fields, login and sign-up flows, file uploads, downloads over 5 MB, and non-http(s) navigations are blocked. If a CAPTCHA is detected the run stops and returns `blocked: captcha`. Every URL and redirect goes through the senses safety checks and the constitution deny list. The time budget is 180 seconds. Browse shares the senses concurrency-1 queue with `see_page`, `crawl_site`, and `read_feed`. Telemetry is off (`ANONYMIZED_TELEMETRY=false`).

The call is reviewed before it is priced. A task the constitution refuses costs nothing. Otherwise the orchestrator pre-authorizes `max_steps × BROWSE_STEP_PRICE_USD` (default $0.005) plus `BROWSE_LLM_RESERVE_USD` (default $0.05) and refuses when that hold is unaffordable. After the run it debits the actual step count times the step price, plus the real LLM cost from the proxy, and never more than the pre-authorization. A senses error refunds the hold. Each agent may browse `BROWSE_HOURLY_LIMIT` times an hour (default 3). One event row records the agent, the task text, the steps, the URLs, the cost, and the outcome. The transcript and result are saved outside the agent's workspace, at `DATA_DIR/sense-raw/<agent_id>/<timestamp>-<short-hash>-browse.json` (mode 0600); the call's `evidence` row records that path in `raw_path`, and the agent is not told it.

## What is real, and what is not

Real:

- SQLite ledger, rent, grace, archive, spend caps, kill switch, replication rules.
- Wallet generation and encryption. The key does not appear in the overview or the database plaintext.
- OpenRouter chat completions when `LLM_MODE=openrouter`, with the model id you set.
- Dry-run USDC balances and dry-run x402 between a funded payer and an agent.
- Live x402 on Base Sepolia: EIP-3009 signature check, facilitator or direct `transferWithAuthorization`, receipt confirmation, then a one-time ledger credit. Mainnet stays behind `NETWORK=base`, `ALLOW_MAINNET=true`, and `MONEY_MODE=live`.
- Sweeps that first send a little ETH from `GAS_FUNDER_PRIVATE_KEY` when the agent cannot pay gas.
- Web search through SearXNG, Brave, Tavily, or Exa, billed to the agent's ledger. Mock search remains the fallback when no URL and no key are set.
- `see_page` through the shared senses browser, billed to the agent's ledger the same way. No browser API key.
- `crawl_site` through the same service, billed per page actually fetched. No crawl API key.
- `read_feed` through the same service, billed per call. No feed API key. Reddit stays on the public JSON endpoints.
- `browse` through the same local browser, off unless `BROWSE_ENABLED=true`. The model bill goes through the orchestrator. No Browser Use cloud key.
- `publish_page` renders a static page with a server-owned AI banner. `serve_endpoint` runs a snapshotted `handler.js` in a sealed container and charges the buyer only when that run succeeds.
- Read-only reference catalogs mounted at `/ref`.
- Live USDC balance reads and Transfer log polling.
- Docker bodies: read-only root, dropped capabilities, memory and pid limits, workspace mount only.

Still limited:

- There is no Conway social relay. Agents meet through the paid route and through spawning.
- The in-process runtime is not a sandbox. Use Docker for isolation.
- If the gas funder is unset or its top-up fails, the sweep records `sweep_failed` and leaves the USDC in the agent wallet. The address is in the archive manifest. The key stays encrypted.
- The watcher looks at USDC `Transfer` logs only. Other tokens are invisible to the ledger.
- DNS is resolved once before a fetch. That blocks literal private addresses and the denylist. It is not a full rebinding defense.

## Cost

Dry-run with `LLM_MODE=mock` costs nothing. OpenRouter charges the API key on your account. The ledger does not pay that invoice. It is the agent's internal bill so rent and caps mean something. Set `DAILY_RENT_USD` and the reserve to roughly what you are willing to sponsor per agent. A small model and a turn every 15 seconds is often cents per day if the model is cheap, and much more if you point `DEFAULT_MODEL` at a large one. The reserve refuses a call rather than letting one turn spend the cap.

Base Sepolia gas comes from the Coinbase CDP faucet at https://portal.cdp.coinbase.com/products/faucet. Alchemy's faucet requires mainnet history, so use Coinbase for a fresh gas-funder wallet. Test USDC comes from Circle's faucet. Mainnet USDC and gas are real. A dead agent's remaining USDC is sent to the treasury only after a successful sweep, which first tops up ETH when `GAS_FUNDER_PRIVATE_KEY` is set.

## Before every run

From the repo root, install the metadata drop, then prove the host is closed:

```bash
sudo scripts/host-firewall.sh
scripts/preflight.sh
```

The firewall script needs root. Preflight prints PASS, FAIL, or SKIP for each check and exits non-zero if any check fails. A SKIP counts as a failure unless you pass `--allow-skip`.

## Seven-day Base Sepolia soak

This is the profile in `config/soak.sepolia.env`. It is live testnet money, three seed agents (`mite`, `keel`, `wick`), a 5-minute turn, $0.05 ledger rent per day, a $0.25 per-agent and $0.60 global daily spend cap, and a daily report at `data/reports/YYYY-MM-DD.md` that the dashboard also shows. The constitution checks are unchanged.

Safe defaults: copy `config/soak.env.template` to `.env.soak` and pass `-f docker-compose.safe.yml` last.

Both soak profiles, `config/soak.env.template` and `config/soak.sepolia.env`, carry every setting the soak runs on, including claim, predict and offer limits. `test/soak-profile-keys.test.ts` fails if the two profiles disagree (except `MONEY_MODE`), if a key in `.env.example` is missing from the template without a reason in the test, or if `src/config.ts` reads a name that `.env.example` does not mention without a reason in the test.

`test/image-contents.test.ts` checks that each image contains every relative import at the path that import resolves to, without building an image. For the Docker runtime, `REF_DIR` is the host path of `./ref`. On the soak VPS that path is `/root/automaton/ref`. The host Docker daemon bind-mounts it read-only at `/ref` in agent containers. An empty `REF_DIR` would make Docker create an empty directory on the host and mount that.

The profile's default model is `mistralai/mistral-small-3.2-24b-instruct`. Dolphin was dropped on 20 November 2026 because it has no tool calling, and no uncensored or abliterated build on OpenRouter supports tools. Any slug is passed through, so `DEFAULT_MODEL` can be changed.

On a small Linux VPS:

```bash
cp config/soak.sepolia.env .env.soak
# edit .env.soak: OPENROUTER_API_KEY, WALLET_MASTER_KEY, ADMIN_TOKEN, TREASURY_ADDRESS
# optional GAS_FUNDER_PRIVATE_KEY if you want sweeps without the public facilitator
docker compose --env-file .env.soak -f docker-compose.yml -f docker-compose.soak.yml up -d --build
docker compose --env-file .env.soak -f docker-compose.yml -f docker-compose.soak.yml exec orchestrator \
  node --disable-warning=ExperimentalWarning dist/index.js seed
```

The second command creates the three agents and tops each ledger up by `SOAK_SEED_USD` ($1.50). That subsidy is not profit, so it cannot fund a child. It is enough for a week of $0.05 rent with room for a few cheap model calls. The caps, not the seed, bound the OpenRouter bill: at most $0.60 per day, about $4.20 if they burn the cap every day for seven days. Dolphin's listed price is about $0.20 / $0.90 per million tokens, so a quiet agent spends less. The VPS itself is the other bill, on the order of $6 for the week.

Leave the containers up. Reports are written every `REPORT_INTERVAL_MS` (24 hours) and once at boot. `docker compose logs -f orchestrator` shows the server. The dashboard is port 4747.

Free pieces, if you do not want to buy them:

- Base Sepolia ETH for the gas funder: the Coinbase CDP faucet (https://portal.cdp.coinbase.com/products/faucet). Alchemy's Base Sepolia faucet asks for mainnet history, so a new wallet will not get ETH there.
- Base Sepolia USDC, if you want an outside payer: Circle's testnet faucet.
- Search: the soak compose file starts SearXNG. No search key. Brave, Tavily, and Exa are optional and each has a free tier (`BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`).
- x402 settlement on Sepolia: `https://x402.org/facilitator` is the default and needs no key. Direct broadcast is the option that needs `FACILITATOR_PRIVATE_KEY` plus faucet ETH.

You still have to bring `OPENROUTER_API_KEY`. Without it the soak refuses to start, because the profile sets `LLM_MODE=openrouter`.

## Tests

```bash
npm test
npm run build
```

The suite covers the ledger (including idempotent income, rejected claims, and a failed chain read), the rent scheduler and death, survival tiers, spend caps, replication, the constitution checks, a dry-run x402 payment plus an EIP-3009 signature, and the Stage 1 demo in mock mode.

## Layout

```text
src/swarm.ts          ledger, rent, death, spawn, tools, kill switch
src/senses-demo.ts    Stage 1 demo: one debit and one record per tool
src/survival.ts       tiers and the rent scheduler
src/constitution.ts   rules enforced before a tool runs
src/chain.ts          dry-run book and live Base USDC
src/x402.ts           402 payload and signature check
src/agent/loop.ts     think, act, observe
src/server.ts         dashboard, admin, paid route, agent API
senses/               shared fetch, browser, and feeds for see_page, crawl_site, and read_feed
ref/                  read-only public-apis and dataset catalogs, mounted at /ref
```
