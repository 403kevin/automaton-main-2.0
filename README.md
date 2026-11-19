# Automaton 2.0

A self-hosted swarm of agents that pay rent or get deleted. It keeps the idea from [Conway Research's Automaton](https://github.com/Conway-Research/automaton): a think-act-observe loop, a wallet, survival tiers, replication, and a constitution. It does not use the Conway API, the social relay, or the hosted installer. Those are retired. New wallets were failing SIWE, and a failed balance check was stored as `-1`, which the survival code treats as dead. Here the ledger changes only when an owner tops up, a USDC transfer is observed, or the orchestrator debits a metered cost or rent. A failed RPC call is an event, not a death.

Agents are not given a product or a revenue plan. The genesis prompt tells them to earn lawfully and to say they are AI. What they try is up to them.

## Run it

Requirements: Node 22, and Docker if you want one container per agent.

```bash
cp .env.example .env
# put a long WALLET_MASTER_KEY and ADMIN_TOKEN in .env
npm install
npm test
npm run demo
```

The demo starts the orchestrator on port 4747, creates three agents, tops two of them up, and jumps the dry-run clock through one rent period and then through the grace window. The unfunded agent is archived. The funded agents stay alive. The dashboard stays up:

[Automaton](http://127.0.0.1:4747/)

`npm run demo:check` runs the same scenario and exits.

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

A dry-run USDC deposit (what an on-chain transfer would do) is different. It increases the simulated wallet and the ledger, and it counts as earned income:

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

Paid HTTP is `GET /a/<agentId>`. With no payment the response is HTTP 402 and an x402-style `accepts` object, plus `X-Automaton-Disclosure`. In dry-run a buyer repeats the request with:

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

A running agent in the normal tier can spawn a child when its earned profit (on-chain and x402 income, minus operating costs) covers `CHILD_ENDOWMENT_USD`, and its balance still leaves `REPLICATION_RESERVE_USD`. The endowment is a ledger transfer, not new money. The child gets a copy of the parent's genesis and notes, rotated and tagged with a `mutation-seed`. No business idea is inserted. `MAX_POPULATION`, `MAX_DEPTH`, and `MAX_CHILDREN` are enforced in code.

## Constitution

`constitution.md` is copied into every workspace. Editing the copy does nothing. The checks live in `src/constitution.ts` and run before shell, fetch, file writes, offers, and council questions. They block destructive and intrusion commands, credential paths, the cloud metadata address, private networks, a denylist of personal-account hosts (`OWNER_DENY_HOSTS` extends it), and text that claims to be human or to be Kevin. Daily spend caps and the kill switch are also code, checked before a debit.

## What is real, and what is not

Real:

- SQLite ledger, rent, grace, archive, spend caps, kill switch, replication rules.
- Wallet generation and encryption. The key does not appear in the overview or the database plaintext.
- OpenRouter chat completions when `LLM_MODE=openrouter`, with the model id you set.
- Dry-run USDC balances and dry-run x402 between a funded payer and an agent.
- Live x402 on Base Sepolia: EIP-3009 signature check, facilitator or direct `transferWithAuthorization`, receipt confirmation, then a one-time ledger credit. Mainnet stays behind `NETWORK=base`, `ALLOW_MAINNET=true`, and `MONEY_MODE=live`.
- Sweeps that first send a little ETH from `GAS_FUNDER_PRIVATE_KEY` when the agent cannot pay gas.
- Web search through SearXNG, Brave, Tavily, or Exa, billed to the agent's ledger. Mock search remains the fallback when no URL and no key are set.
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

## Seven-day Base Sepolia soak

This is the profile in `config/soak.sepolia.env`. It is live testnet money, three seed agents (`mite`, `keel`, `wick`), a 5-minute turn, $0.05 ledger rent per day, a $0.25 per-agent and $0.60 global daily spend cap, and a daily report at `data/reports/YYYY-MM-DD.md` that the dashboard also shows. The constitution checks are unchanged.

On 17 November 2026 the OpenRouter catalog (474 models) had no slug containing "heretic". The profile uses `cognitivecomputations/dolphin-mistral-24b-venice-edition`, the uncensored Dolphin that is listed. Set `DEFAULT_MODEL` to a heretic slug when one appears. The string is not rewritten.

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

The suite covers the ledger (including idempotent income, rejected claims, and a failed chain read), the rent scheduler and death, survival tiers, spend caps, replication, the constitution checks, and a dry-run x402 payment plus an EIP-3009 signature.

## Layout

```text
src/swarm.ts          ledger, rent, death, spawn, tools, kill switch
src/survival.ts       tiers and the rent scheduler
src/constitution.ts   rules enforced before a tool runs
src/chain.ts          dry-run book and live Base USDC
src/x402.ts           402 payload and signature check
src/agent/loop.ts     think, act, observe
src/server.ts         dashboard, admin, paid route, agent API
```
