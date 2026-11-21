# BO-3.1d — host firewall blocks container-to-host connections

Spec for ORDER BO-3.1d (section 54 of `AUTOMATON_COLLAB_FOR_GROK.md`). It follows [BO-3.1c](BO-3.1c-strip-types.md).
There is no `BO-0.3` file under `repo/specs/`. This spec carries that plan row's requirement: no host port other than the orchestrator is reachable from an agent. The orchestrator itself is reached by Docker DNS, not by a host port.
Format: `to-spec` (mattpocock/skills). It lives in `repo/specs/` for the same reason as the earlier specs.
Nothing here changes spend caps, guards, tools, or what an agent may do.

## Problem Statement

Preflight check 2 failed on the soak VPS. A container on `automaton_default` opened a connection to the bridge gateway `172.18.0.1` port 22, and sshd answered. That gateway is the host. The packet arrives on a Docker bridge interface and is delivered to the host's INPUT chain. `DOCKER-USER` never sees it, because that chain filters forwarded traffic. `scripts/host-firewall.sh` only drops the metadata address. A rebuild of the server would boot without the INPUT drop that Part A installed by hand.

## Solution

The host firewall script also ensures two INPUT rules: new connections that arrive on `br-+` or `docker0` are dropped. Each rule is checked before it is inserted, then saved the same way as the metadata rule. `--check` says `present` only when the metadata rule and both INPUT rules are there. No other interface is named, and no policy changes. The soak keeps the rules Part A already loaded. This PR is not deployed over the running soak.

## User Stories

1. As Kevin, I want new connections from a container to the host, on any compose bridge, to be dropped, so that sshd on the gateway does not answer.
2. As Kevin, I want the same drop on `docker0`, so that the default bridge is covered when it is up.
3. As Kevin, I want SSH on the public interface left alone, so that a firewall run does not lock the operator out.
4. As Kevin, I want established replies left alone, so that the host can still reach a published container port.
5. As Kevin, I want each rule checked before insert, so that running the script twice does not stack copies.
6. As Kevin, I want the rules saved with `netfilter-persistent save` when that command exists, so that a reboot keeps them.
7. As Kevin, I want `--check` to print `present` and exit 0 only when all three rules exist, so that a missing INPUT rule is not hidden by the metadata rule.
8. As Kevin, I want `--check` to exit 1 when any one of the three is missing, and 2 when iptables cannot answer, so that the old exit codes still mean the same thing.
9. As Kevin, I want no rule for any interface other than `br-+` and `docker0`, so that the public NIC is not matched.
10. As Kevin, I want the README to say what the script drops, so that the next rebuild is not a surprise.

## Implementation Decisions

**Rules.** Besides the existing metadata drop, the script ensures:

- `iptables -C INPUT -i br-+ -m conntrack --ctstate NEW -j DROP`, and if that is absent, `iptables -I INPUT 1 -i br-+ -m conntrack --ctstate NEW -j DROP`
- the same pair for `-i docker0`

**Check.** `--check` prints one word. `present` and exit 0 only when all three rules match. `absent` and exit 1 when any one does not. Exit 2 when the check cannot be run. It inserts nothing.

**Unchanged.** The INPUT policy stays whatever it already is. No rule names another interface. The metadata rule's chain and arguments stay as they are. The script stays idempotent and still refuses to change rules when it is not root.

## Testing Decisions

The seam is the script's process, with `iptables`, `netfilter-persistent`, and `id` replaced on `PATH`. Prior art is the other source-level tests that spawn nothing on the real host. A good test records the fake `iptables` arguments and does not change the machine's firewall.

- When the INPUT rules are absent, the script inserts both, at INPUT position 1, and does not insert a second metadata rule that is already present.
- When all three are present, the script inserts nothing.
- `--check` exits 1 when any one of the three is missing, and exits 0 when all three are present.
- Every `-i` value in the recorded commands is `br-+` or `docker0`.

## Out of Scope

- Redeploying this script onto the running soak.
- Changing the INPUT policy, `DOCKER-USER` beyond the existing metadata drop, or any public interface.
- Archiving the preflight probe. The only admin kill path stops every living agent.

## Further Notes

- Part A already inserted and saved these two INPUT rules on the soak VPS, and preflight then passed check 2.
- A connection to the bridge gateway is INPUT, not FORWARD. That is why the metadata rule in `DOCKER-USER` did not cover port 22.
