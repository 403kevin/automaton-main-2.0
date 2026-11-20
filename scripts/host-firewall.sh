#!/usr/bin/env bash
# Drop the cloud metadata address in Docker's DOCKER-USER chain, once.
# The inserted command is exactly:
#   iptables -I DOCKER-USER -d 169.254.169.254 -j DROP
# Presence is checked with iptables -C before any insert.
# Persists with `netfilter-persistent save` when that binary exists.
# Otherwise prints that command for the operator. Idempotent. Needs root.
# --check only reports whether the rule exists: exit 0 present, 1 absent.
# Exit 2 means the check could not be run (no iptables, or no permission).

set -euo pipefail

CHAIN="DOCKER-USER"
RULE_ARGS=(-d 169.254.169.254 -j DROP)

usage() {
  printf 'Usage: scripts/host-firewall.sh [--check]\n' >&2
  exit 2
}

find_bin() {
  local name="$1"
  local path
  if path=$(command -v "$name" 2>/dev/null); then
    printf '%s\n' "$path"
    return 0
  fi
  if [[ -x "/usr/sbin/${name}" ]]; then
    printf '/usr/sbin/%s\n' "$name"
    return 0
  fi
  if [[ -x "/sbin/${name}" ]]; then
    printf '/sbin/%s\n' "$name"
    return 0
  fi
  return 1
}

# Prints "present" or "absent" and returns 0 or 1.
# Returns 2 when iptables cannot answer.
rule_state() {
  local iptables="$1"
  local err rc
  if err=$("$iptables" -C "$CHAIN" "${RULE_ARGS[@]}" 2>&1); then
    printf 'present\n'
    return 0
  else
    rc=$?
  fi
  local lower
  lower=$(printf '%s' "$err" | tr '[:upper:]' '[:lower:]')
  if [[ "$lower" == *"permission denied"* || "$lower" == *"must be root"* || "$lower" == *"operation not permitted"* ]]; then
    printf 'error: %s\n' "$err" >&2
    return 2
  fi
  if [[ "$rc" -eq 1 || "$lower" == *"bad rule"* || "$lower" == *"no chain"* || "$lower" == *"does a matching rule exist"* ]]; then
    printf 'absent\n'
    return 1
  fi
  printf 'error: %s\n' "$err" >&2
  return 2
}

persist_rule() {
  local bin
  if bin=$(find_bin netfilter-persistent); then
    if "$bin" save; then
      printf 'persisted: netfilter-persistent save\n'
      return 0
    fi
    printf 'netfilter-persistent save failed.\n' >&2
    return 1
  fi
  printf 'netfilter-persistent is not installed. Persist the rule by running:\n'
  printf 'netfilter-persistent save\n'
}

main() {
  local check_only=0
  if [[ "$#" -gt 1 ]]; then
    usage
  fi
  if [[ "$#" -eq 1 ]]; then
    case "$1" in
      --check) check_only=1 ;;
      -h|--help) usage ;;
      *) usage ;;
    esac
  fi

  local iptables
  if ! iptables=$(find_bin iptables); then
    printf 'error: iptables is not installed\n' >&2
    exit 2
  fi

  if [[ "$check_only" -eq 1 ]]; then
    local state rc=0
    state=$(rule_state "$iptables") || rc=$?
    if [[ "$rc" -eq 0 || "$rc" -eq 1 ]]; then
      printf '%s\n' "$state"
    fi
    exit "$rc"
  fi

  if [[ "$(id -u)" -ne 0 ]]; then
    printf 'scripts/host-firewall.sh must run as root.\n' >&2
    exit 1
  fi

  local state rc=0
  state=$(rule_state "$iptables") || rc=$?

  if [[ "$rc" -eq 0 ]]; then
    printf 'already present: iptables -I DOCKER-USER -d 169.254.169.254 -j DROP\n'
  elif [[ "$rc" -eq 1 && "$state" == "absent" ]]; then
    local insert_err=""
    if ! insert_err=$("$iptables" -I "$CHAIN" "${RULE_ARGS[@]}" 2>&1); then
      printf '%s\n' "$insert_err" >&2
      local lower_err
      lower_err=$(printf '%s' "$insert_err" | tr '[:upper:]' '[:lower:]')
      if [[ "$lower_err" == *"no chain"* ]]; then
        printf 'DOCKER-USER is created when Docker starts. Start the daemon and re-run.\n' >&2
      fi
      exit 1
    fi
    printf 'inserted: iptables -I DOCKER-USER -d 169.254.169.254 -j DROP\n'
  else
    exit "$rc"
  fi

  persist_rule
}

main "$@"
