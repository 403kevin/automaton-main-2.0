# BO-3.1b — images contain everything they import

Spec for ORDER BO-3.1b (section 46 of `AUTOMATON_COLLAB_FOR_GROK.md`). It follows [BO-3.1a](BO-3.1a-soak-profile-keys.md).
Format: `to-spec` (mattpocock/skills). It lives in `repo/specs/` for the same reason as the earlier specs.
Nothing here changes spend caps, guards, tools, or what an agent may do.

## Problem Statement

The soak stack did not start. The senses container exits because it imports a feeds module the image never copies, and the orchestrator waits until senses is healthy. The tests did not catch it, because they run from the source tree and never build an image. Two more gaps would have stopped the soak next: `seed` reads `config/soak.sepolia.env` from the container filesystem, which the orchestrator image does not contain, and an empty `REF_DIR` makes the host Docker daemon mount an empty directory into agents.

## Solution

The senses image copies the feeds folder next to its source. `seed` with no file argument uses the process environment when the default soak file is absent, and says so in one log line. An explicit missing file is still an error. Both soak profiles set `REF_DIR` to the host path of `ref` on the soak VPS. A static test walks relative imports and fails when a copied layout would not resolve them.

## User Stories

1. As Kevin, I want the senses image to include the feeds modules the server imports, so that the container stays up.
2. As Kevin, I want a misplaced copy to fail the test, so that a folder copied into the wrong directory does not look fixed.
3. As Kevin, I want `seed` inside the orchestrator container to use the environment it was given when the soak file is not in the image, so that seeding does not throw a missing-file error.
4. As Kevin, I want an explicit missing config path to still fail, so that a typo is not silently ignored.
5. As Kevin, I want the admin token and the model allowlist to keep working when seed uses the environment, so that this path is not a weaker one.
6. As Kevin, I want `REF_DIR` written in both soak profiles as the host path `/root/automaton/ref`, so that agents mount the real reference files.
7. As Kevin, I want the old "default path" excuse for `REF_DIR` removed, so that the profile test requires the host path.
8. As Kevin, I want the image check to fail on today's Dockerfile with the feeds line removed, so that the check is proven against the bug it exists for.
9. As Kevin, I want no copy of `config` into the image, so that the container does not depend on a file the soak already passed in as environment.
10. As Kevin, I want the orchestrator's own source imports to stay inside `src`, and `constitution.md` to stay in the image, so that the other image is checked the same way.

## Implementation Decisions

**Senses image.** Add `COPY senses/feeds ./feeds` beside `COPY senses/src ./src`. No other line in that Dockerfile changes.

**Seed.** `runSoak` with no file argument, when `config/soak.sepolia.env` is absent, does not read a file. It logs `No config/soak.sepolia.env here; using the process environment.` and continues with `process.env`. A file argument that is missing is still an error. `ADMIN_TOKEN` is still required to seed a server that is already up. The allowlist checks are unchanged. `config` is not copied into the image.

**REF_DIR.** Both soak profiles set `REF_DIR=/root/automaton/ref`, with the comment that this is the host path of `./ref` on the soak VPS, where BO-3.1 deploys to `/root/automaton`, and that the host Docker daemon bind-mounts it read-only at `/ref` in agent containers. `REF_DIR` leaves the `NOT_IN_SOAK` map. No other excuse changes.

**The image check is static.** No Docker and no new dependency. It parses `WORKDIR` and every `COPY`, maps relative imports from the senses server through `.ts` files, and requires each target to exist at the image path the relative import resolves to. The orchestrator check requires every relative import under `src` to stay inside `src`, a `COPY` of `constitution.md`, and the default soak path either copied or handled when missing. An in-memory copy of the senses Dockerfile with the feeds line removed must report `feeds`.

**README.** One paragraph on this test and on `REF_DIR` for the Docker runtime.

## Testing Decisions

The seams are the Dockerfile and source text, the two soak profiles, and `seed` against a fake healthy server. Prior art is the soak-profile key test, which already parses env files, and the compose-config test, which already reads source without starting a process.

- Senses imports resolve in the image, and every failure is listed.
- The same check on a Dockerfile text without the feeds copy reports `feeds`.
- Orchestrator imports stay in `src`, `constitution.md` is copied, and the default soak file is handled when missing.
- With no file argument, the default file absent, and a fake server answering `/health`, seed creates mite, keel and wick through the admin HTTP path.
- A given missing file is still an error.
- Removing `REF_DIR` from the excuse map makes the profile test require it in both profiles.

A good test here does not build an image. The order's separate image start check is outside the unit tests.

## Out of Scope

- Copying `config` into an image.
- Changing compose, caps, guards, tools, or model lists.
- Installing Docker inside WSL.
- A host firewall change on the VPS.

## Further Notes

- Vitest runs from the checkout, where `senses/feeds` exists, which is why the crash was invisible until the image started.
- `RUNTIME=local` is not a value the config accepts. A non-Docker runtime is `process`.
