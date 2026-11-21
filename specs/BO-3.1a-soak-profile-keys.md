# BO-3.1a — soak profiles carry every setting

Spec for ORDER BO-3.1a (section 42 of `AUTOMATON_COLLAB_FOR_GROK.md`). It follows [BO-2.4b](BO-2.4b-agent-model-compose.md). Follow-up: [BO-3.1b](BO-3.1b-image-contents.md) makes the images contain every file they import, and sets `REF_DIR` to the host path.
Format: `to-spec` (mattpocock/skills). It lives in `repo/specs/` for the same reason as the earlier specs: `spec-artifact` points at Omega's `20-CONTROL/specs/`, which is outside this git repo and could not be cited from the PR.
Nothing here changes spend caps, guards, tools, or what an agent may do. It writes down settings the soak was already using as code defaults, and it makes the two soak profiles list the same keys.

## Problem Statement

The Stage 3 soak stopped at the compose name check because `CLAIM_*`, `PREDICT_*` and `OFFER_*` were not in the orchestrator environment list. That was not a compose forwarding bug. The safe path loads the whole of `.env.soak`, and that file was copied from the soak template, which never contained those keys. The orchestrator would have used the defaults in config, which match the plan where the plan gives a value, but a setting that exists only as a default is invisible in the soak profile. The same pass found more keys in `.env.example` that the template omits, 22 keys the template has that the Sepolia profile lacks, and nine names the config reads that `.env.example` never mentions. The BO-2.4b compose test treats "the env file is loaded" as "every setting is forwarded", so it never required the setting to be written in the profile.

## Solution

Both soak profiles gain the missing settings, with the source of each new value in a comment. The Sepolia profile gains every key the template has, at the template's value, except `MONEY_MODE`. `.env.example` gains commented lines for the three settings an owner might set. A test fails when a new `.env.example` key is absent from the template without a written reason, when the two profiles disagree, when config reads a name that `.env.example` does not mention without a written reason, or when loading either profile does not produce the six claim, predict and offer values.

## User Stories

1. As Kevin, I want the claim cost and hourly limit written in both soak profiles, so that the soak is not silently on a code default.
2. As Kevin, I want the predict cost written as the plan's $0.0001 and the hourly limit written as the code default, so that the profile matches the plan.
3. As Kevin, I want the offer re-test interval written as 6 hours and the free-check hourly limit written as the code default, so that those gates are visible in the soak file.
4. As Kevin, I want clock control explicitly false in both profiles, so that a live soak cannot inherit the dry-run default that allows clock jumps.
5. As Kevin, I want `OWNER_DENY_HOSTS` present and empty, as in the example file, so that an empty deny list is a choice recorded in the profile.
6. As Kevin, I want the Sepolia profile to list every key the template lists, at the same value except money mode, so that the file the older soak command names is not a thinner copy.
7. As Kevin, I want the optional search keys, the USDC address, the handler image and the ref directory excused in the test with a reason, so that settings the soak does not use do not have to be copied in.
8. As Kevin, I want a new example-file key to fail the test until it is in the template or excused, so that this gap cannot recur quietly.
9. As Kevin, I want every name the config reads to be in the example file or excused as internal plumbing, so that an owner can see what can be set.
10. As Kevin, I want the OpenRouter URL and the USDC name and version available as commented example lines, so that I can set them later without hunting the source.
11. As Kevin, I want loading each profile, with dummy secrets, to yield the six written values, so that a comment or a typo cannot leave the default in charge while the file looks filled in.
12. As Kevin, I want no change to application code or to compose, so that this fix cannot alter forwarding or runtime behaviour beyond making the written values the ones that load.

## Implementation Decisions

**Cause.** On the safe path the soak env file is loaded whole, so every key in it reaches the orchestrator. The six names were missing from that file. The plan and the code defaults agree wherever the plan states a value: predict costs $0.0001 and the offer re-test is 6 hours. Claim cost, claim hourly limit, predict hourly limit and offer-check hourly limit have no plan value; they stay on the code defaults, written out.

**Do not add these names under compose `environment:`.** The env file already passes every key. Naming them again in compose would override the env file with a second default.

**Both profiles gain these assignments, each with a source comment:**

- `CLAIM_COST_USD=0.0001` — code default; the plan gives none
- `CLAIM_HOURLY_LIMIT=30` — code default
- `PREDICT_COST_USD=0.0001` — the plan's $0.0001, equal to the default
- `PREDICT_HOURLY_LIMIT=10` — code default
- `OFFER_RETEST_INTERVAL_MS=21600000` — the plan's 6 hours, equal to the default
- `OFFER_CHECK_HOURLY_LIMIT=20` — code default
- `ALLOW_CLOCK_CONTROL=false` — explicit, including for live mode
- `OWNER_DENY_HOSTS=` — empty, as in the example file

**The Sepolia profile gains every template key**, at the template's value. That includes the 22 keys that were only in the template: every browse, crawl, read-feed and see-page key, the serve keys, the publish-page price, both handler timeouts, the senses URL, the Reddit user agent, and the constitution deny hosts. The only value that may differ is `MONEY_MODE` (`dry-run` in the template, `live` in the Sepolia profile). Comments may differ.

**The example file** gains commented lines for `OPENROUTER_URL`, `USDC_NAME` and `USDC_VERSION`. No other example-file value changes.

**No change under `src/` and no compose change.**

**README.** One paragraph: both soak profiles carry every setting, and a test enforces it.

## Testing Decisions

One new test file. It does not start a server. Prior art is the profile section of the report test, which already loads both soak files through `loadEnvFile` and `loadConfig`, and the compose-config test, which already parses `env.NAME` and `# KEY=` lines.

- **Example file to template.** Every key in the example file, including a commented `# KEY=` line, is an assignment in the template, or it is on a `NOT_IN_SOAK` map with a reason. The expected excuses are the three optional search API keys (unused with SearXNG), `USDC_ADDRESS` (network default), `HANDLER_IMAGE` (defaults to `AGENT_IMAGE`) and `REF_DIR` (default path).
- **Profiles agree.** The two profiles have the same key set and the same values except `MONEY_MODE`.
- **Config to example file.** Every `env.NAME` read in `src/config.ts` is a key or a commented key in the example file, or it is on an `INTERNAL` map with a reason. The expected internal names are `AGENT_IMAGE_HAS_NODE`, `CONSTITUTION_PATH`, `INTERNAL_LLM_ALLOW_CIDRS`, `INTERNAL_LLM_HOST`, `INTERNAL_LLM_PORT` and `SENSES_LLM_BASE_URL`, because compose sets them or they are fixed paths. `OPENROUTER_URL`, `USDC_NAME` and `USDC_VERSION` are commented in the example file instead of being excused.
- **Values load.** `loadConfig` on each profile, with dummy secrets, returns claim cost 0.0001, claim hourly limit 30, predict cost 0.0001, predict hourly limit 10, offer re-test 21600000 and offer-check hourly limit 20.

A good test here reads the files and the loaded config. It does not inspect how compose interpolates a name.

## Out of Scope

- Adding these keys under compose `environment:`.
- Changing any default, cap, guard, tool or model.
- Reinstalling a host firewall on the VPS. That stays in the soak resume.
- Filling search API keys, a custom USDC address, a handler image or a ref directory into the soak.

## Further Notes

- Stopping the soak at the missing names was what the previous order required. The soak would have run on the plan's values via code defaults. The fix is to make those values visible and checked.
- The nine names absent from the example file before this order are the six internal names plus the three commented lines above.
