# BO-3.1c — senses runs under Node's type stripping

Spec for ORDER BO-3.1c (section 50 of `AUTOMATON_COLLAB_FOR_GROK.md`). It follows [BO-3.1b](BO-3.1b-image-contents.md).
Format: `to-spec` (mattpocock/skills). It lives in `repo/specs/` for the same reason as the earlier specs.
Nothing here changes spend caps, guards, tools, or what an agent may do.

## Problem Statement

The senses container still does not stay up. After the feeds folder was copied into the image, Node started `src/server.ts` and exited on `senses/src/crawl.ts` line 460: `constructor(private delayMs: number) {}`. The image runs that TypeScript file directly. Node's strip-only mode deletes type annotations and refuses syntax that would have to generate code, including a parameter property. The suite never applied those rules. Vitest compiles the files itself, `npm run typecheck` does not include `senses\`, and nothing started `node senses/src/server.ts` under plain Node.

## Solution

The one parameter property in code the senses container runs as TypeScript becomes an ordinary field plus an assignment. Behaviour of the pacer is unchanged. A comment on the senses image records that it runs under Node's strip-only mode and which Node the base image shipped on 2026-11-21. A test runs Node's own stripper over every TypeScript file that container executes, and fails if any of them is not erasable. The README says that rule out loud.

## User Stories

1. As Kevin, I want the pacer's delay to be stored in a normal field, so that Node can load the crawl module under strip-only mode.
2. As Kevin, I want the delay value passed to the constructor to be the value the pacer waits on, so that crawl pacing does not change.
3. As Kevin, I want `setDelay` to keep updating that same field, so that a later delay change still takes effect.
4. As Kevin, I want the senses image comment to name strip-only mode and Node 26.13.1, so that the next reader knows why erasable syntax is required.
5. As Kevin, I want that comment to name the test that enforces the rule, so that the Dockerfile points at the check.
6. As Kevin, I want no other Dockerfile line to change, so that the image pins and copy list stay as reviewed.
7. As Kevin, I want every `.ts` file under `senses\src\` and `senses\feeds\`, plus `src\constitution.ts`, to pass `stripTypeScriptTypes` in strip mode, so that a new parameter property cannot ship.
8. As Kevin, I want a failure to name the file, so that the report shows where the syntax is.
9. As Kevin, I want a parameter property and an enum in the test itself to throw, so that a Node which silently accepts them does not look like a pass.
10. As Kevin, I want every relative import in those files to end in `.ts`, so that `node src/server.ts` can resolve them.
11. As Kevin, I want both Dockerfiles to keep an explicit version tag, so that `latest` or an untagged `FROM` is a test failure.
12. As Kevin, I want a missing `stripTypeScriptTypes` to fail the test with a clear message, so that the check is not skipped.
13. As Kevin, I want the README to say that senses runs under Node type stripping and that only erasable TypeScript is allowed in `senses\` and `src\constitution.ts`, so that the rule is visible without reading the test.
14. As Kevin, I want the 19 parameter properties in compiled core source left alone, so that this order does not rewrite code `tsc` already emits as JavaScript.
15. As Kevin, I want `erasableSyntaxOnly` left off the root `tsconfig.json`, so that the compiled core is not forced through a senses rule.

## Implementation Decisions

**Pacer.** At `senses\src\crawl.ts:460`, replace `constructor(private delayMs: number) {}` with a declared field `private delayMs: number;` and `constructor(delayMs: number) { this.delayMs = delayMs; }`. No other line in that file changes.

**Senses image.** Add one comment above `CMD`: "Runs src/server.ts with Node's built-in type stripping (strip-only). The base image ships Node 26.13.1 (seen 2026-11-21). Only erasable TypeScript is allowed; test/strip-types.test.ts enforces it." Both base images stay on their current tags.

**Strip check.** No new dependency. The test calls `stripTypeScriptTypes(code, { mode: "strip" })` from `node:module`.

**Left as they are.** Core `src\` parameter properties stay, because `tsc` compiles them and the orchestrator runs `dist` JavaScript. Root `tsconfig.json` does not gain `erasableSyntaxOnly`.

## Testing Decisions

The seam is Node's stripper plus the source text. Prior art is `test/image-contents.test.ts`, which already reads source and Dockerfiles without starting a process. A good test calls the stripper and does not reimplement it.

- Every `.ts` file under `senses\src\` and `senses\feeds\`, plus `src\constitution.ts`, strips without throwing. Failures are collected and printed with file paths.
- `class A { constructor(private x: number) {} }` throws, and `enum E { A }` throws.
- Every relative import in those files ends in `.ts`.
- The `FROM` lines of `Dockerfile` and `senses\Dockerfile` carry an explicit version tag, not `latest` and not untagged.
- If `stripTypeScriptTypes` is missing, the test fails with a clear message and is not skipped.

Starting the senses server and the orchestrator under plain Node is the order's separate check, outside this unit test.

## Out of Scope

- Rewriting parameter properties in core `src\` that `tsc` compiles.
- Turning on `erasableSyntaxOnly`.
- Changing image tags, copy lines, caps, guards, tools, or model lists.
- A host firewall change on the VPS.

## Further Notes

- The section 49 log showed Node v26.13.1 on `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at `file:///app/src/crawl.ts:460`.
- Node 22 since 22.18 and Node 26 use the same strip-only rules. The version gap is not the cause. The order still starts senses under both.
- `RUNTIME=process` is the non-Docker value `src\config.ts` accepts. `auto` and `docker` are the other two. `local` is not valid.
