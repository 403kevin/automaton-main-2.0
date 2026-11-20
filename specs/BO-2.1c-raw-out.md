# BO-2.1c — raw sense files out of the workspace, `write_file` realpath check, `fetch_url` through the tripwires

Spec for ORDER BO-2.1c (section 22 of `AUTOMATON_COLLAB_FOR_GROK.md`). Follows [BO-2.1](BO-2.1-tripwires.md), whose "Read-back" section lists the gaps this closes.
Format: `to-spec` (mattpocock/skills). It lives in `repo/specs/` for the same reason as the BO-2.1 spec: `spec-artifact` points at Omega's `20-CONTROL/specs/`, which is outside this git repo and could not be cited from the PR.

## Problem Statement

BO-2.1 and BO-2.1-fix fence and quarantine what the sense tools return to the model, and `read_file` now fences anything it reads from `evidence/`. Three holes remain at the same boundary:

1. `crawl_site`, `read_feed` and `browse` each save the full raw JSON of what they fetched into the agent's own `evidence/` folder. The agent's `shell` tool can `cat` or `grep` those files, and shell output comes back unscanned and unfenced, so a quarantined injection is one `cat` away.
2. `write_file` checks only that the path string stays under the workspace. A symlink inside the workspace (the agent can make one with `shell`) lets it write outside, or to a new file under a linked directory.
3. `fetch_url` runs inside the agent process and returns raw page text. The orchestrator never sees it, so it is not scanned, fenced, quarantined or recorded.

## Solution

Raw sense files are written where no agent can reach them, under the orchestrator's data directory, and the workspace keeps no copy. `write_file` resolves real paths before it writes. `fetch_url` is performed by the orchestrator through the same wrapper as the four sense tools, so its output is scanned, fenced or quarantined and leaves one evidence row.

## User Stories

1. As Kevin, I want the raw crawl, feed and browse JSON stored outside every agent workspace, so that an agent cannot read back text that was quarantined.
2. As Kevin, I want each evidence row to say where its raw file is, so that I can find it without searching.
3. As an agent, I want the tool result to still carry the guarded previews it carries today, so that I lose nothing I could safely use.
4. As Kevin, I want `write_file` to refuse a write that would land outside the workspace through a symlink, so that an agent cannot overwrite or plant files elsewhere.
5. As an agent, I want ordinary `write_file` calls (new file, new nested folder) to keep working, so that the fix does not break my notes.
6. As Kevin, I want `fetch_url` output scanned, fenced or quarantined like a sense result, so that a hostile page cannot reach the model raw by this door.
7. As Kevin, I want one evidence row per `fetch_url` call, refused calls included, so that the table has no gaps.
8. As Kevin, I want screenshots to keep working exactly as now, so that the one binary evidence type is unaffected.
9. As Kevin, I want a blocked feed to still record its row and keep its fee, so that existing accounting does not change.

## Implementation Decisions

**Raw files.** `crawl_site`, `read_feed` and `browse` write their full JSON to `DATA_DIR/sense-raw/<agent_id>/<timestamp>-<hash8>-<crawl|feed|browse>.json`, mode 0600, never inside a workspace (the same pattern as the quarantine folder, a sibling of `agents/`). The runtimes mount only the agent's workspace folder, so the agent cannot name or reach this folder. A blocked feed is still saved, as today. The three save functions become one that takes the agent id and a kind.

**`evidence.raw_path`.** A new nullable column, stored relative to `DATA_DIR` (`sense-raw/<agent_id>/<file>`), set for the calls that saved a raw file and null for the rest (`see_page`, `fetch_url`, refused calls). It is added by an idempotent migration to an evidence table that lacks it, like `quarantine_path`. The tool methods hand the path to `senseCall`, which passes it to the single `recordEvidence`; the agent never sees it. `quarantine_path` is unchanged. The event-log text for these calls now says `raw=<path>` instead of `evidence=<workspace path>`.

**What the workspace keeps: nothing.** The tool result already carries guarded text: about 2000 characters per crawled page, 500 per feed item, and the browse result and URLs, all inside the fence. A second copy in the workspace would be a second unguarded door (shell) or would need its own guard, and an agent that wants more of a page can call the tool again. The cost is that an agent cannot re-read the full crawl JSON for free; it would have to spend a call. The result text stops saying "Saved … to evidence/…" and says the raw copy is stored outside the agent's workspace. A guarded summary file was rejected: it would duplicate what the result already shows.

**PNGs stay.** `see_page` with `screenshot` still writes `evidence/<timestamp>-<hash8>.png` in the workspace, after the PNG magic-byte check. It is binary and carries no text to a model. The `read_file` guard on `evidence/` from BO-2.1-fix stays as defence in depth for these and for older files.

**`write_file` realpath rule.** Before writing, resolve the real path of the workspace and of the nearest existing ancestor of the target, and refuse (with the existing "Paths must stay inside the workspace.") if that ancestor is not inside the real workspace. Refuse if the target itself exists and is a symlink (`lstat`), whatever it points at. Only after those checks does it create missing folders and write. This covers a file link to an outside file and a directory link with a new file under it. The `..` and absolute-path refusals that already exist are unchanged.

**`fetch_url` through the wrapper.** `fetch_url` joins the four sense tools in `senseCall`. The orchestrator reviews the URL (constitution and private-network rules, as now), charges the existing `fetch_url` price, fetches it itself with redirects not followed and a 15 second timeout (as `pay_request` already does from the orchestrator), reads at most 100,000 bytes of the body, and returns `HTTP <status>\n<first 12,000 characters>`, as today. That text goes through `guardSenseText`: low and medium come back fenced, high and critical come back as a quarantine result with the raw text stored under `quarantine/`, and one evidence row is written (`tool` is `fetch_url`, `url` is the URL; a refused call is `refused`, `threat_level` `none`). The branch in the agent's local tool runner keeps its URL review but no longer fetches: it returns "handled by the orchestrator". A failed fetch (timeout, connection error) returns a refusal with the error message; the fee is not refunded, as before.
- **Egress moves.** The request now leaves the orchestrator, not the agent's container. That is the same trust as `pay_request`, and the URL review is the same, but a DNS rebind between the review and the fetch now hits the orchestrator's network. Closing that is the Stage 3 network egress policy; it is not attempted here.
- Fetches made from inside `shell` (`curl` and the like) are out of scope; that is Stage 3 egress policy.

**README.** The three sentences that say the raw JSON is saved under `evidence/` are corrected.

**No new dependencies. Mock mode only. No new paid calls.**

## Testing Decisions

- Seams: `Swarm.handleTool` with a mock senses client and a stubbed global `fetch` (the existing pattern in `test/stage-demo.test.ts`); `executeLocalTool` for what the agent can do with `shell` and `write_file` in its workspace. Fixtures only, no network.
- Cases (the order's four groups plus `fetch_url`):
  1. After hostile mocked `crawl_site`, `read_feed` and `browse` calls, `shell` `grep -r` in the workspace finds none of the injection text, and neither does a walk of the workspace files.
  2. Each of those evidence rows has `raw_path` set, and the file exists under `DATA_DIR/sense-raw/<agent_id>/`, outside the workspace, mode 0600, with the raw text.
  3. `write_file` through a file symlink and through a directory symlink is refused and the outside files are unchanged.
  4. Unchanged: a normal `write_file` (including a new nested folder) works; a `see_page` screenshot still lands in `evidence/`; a blocked feed still records its row and keeps its fee; the existing fee, refund, quarantine and fence tests pass.
  5. `fetch_url`: an injection page is quarantined (critical) with a row and a `quarantine_path`; a benign page comes back unchanged inside the fence; one row per call, refused included; redirects are not followed; a huge body is cut; the local runner no longer fetches.
- Three existing tests read the raw JSON from the workspace and now read it from `sense-raw/`; one `evidence.test.ts` read-back test now plants its own file under `evidence/`. Those edits are called out in the PR.

## Out of Scope

- `RUNTIME=process` isolation (Stage 3: Docker runtime only on the server). In process mode the shell can still read `DATA_DIR` by absolute path.
- Network egress policy, including `curl` from `shell` and DNS rebinding (Stage 3).
- Fencing `shell` output in general, and `web_search`.
- `claim` and `facts` (BO-2.1b).

## Further Notes

- `RUNTIME=process` still lets the agent's `shell` reach every file under `DATA_DIR`, including `sense-raw/` and `quarantine/`. The "outside the workspace" guarantee holds for the container runtimes and for `read_file`, `write_file` and `/ref`.
- Raw files accumulate with no cleanup. That is unchanged from before (they sat in the workspace); a retention rule is a later item.
