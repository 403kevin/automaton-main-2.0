#!/usr/bin/env bash
# Prove the host is closed before a run. Prints one PASS, FAIL, or SKIP line
# per check and exits non-zero if any check fails. SKIP counts as a failure
# unless --allow-skip is set. Secret values are never printed.
#
# 1. 169.254.169.254 is unreachable from a throwaway container on DOCKER_NETWORK
#    (default automaton_default), with a 3s timeout.
# 2. From that container, ports 22, 80, 443, and 4747 on the network gateway
#    are not reachable. Agents reach the orchestrator via Docker DNS on the
#    compose network, not the host. The dashboard is bound to 127.0.0.1, so
#    port 4747 on the gateway must be closed too.
# 3. Nothing is listening on 4747 on a public interface (ss -ltn).
#    127.0.0.1 and ::1 are loopback and are allowed.
# 4. WALLET_MASTER_KEY, ADMIN_TOKEN, and TREASURY_ADDRESS are non-empty in .env.soak.
# 5. POST /admin/kill-switch {"enabled":true} — the same call as
#    `node dist/index.js kill` — stops a running test agent container within 30s.
# 6. GET /api/overview — the same call as `node dist/index.js status` — reports
#    agentCap, globalCap, maxPopulation, and maxDepth matching .env.soak.

set -euo pipefail

ROOT=""
BASE_URL=""
NETWORK=""
PORT_NUM=""
PREFLIGHT_TOKEN=""
AGENT_IMAGE_NAME=""
ADMIN_TOKEN_FROM_ENV="${ADMIN_TOKEN:-}"
ALLOW_SKIP=0
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
DOCKER=(docker)
NEED_KILL_RESTORE=0
KILL_PREV="off"
PROBE_ID=""
REMOVE_PROBE=0
HTTP_CODE=""
HTTP_BODY=""
META_RESULT=""
PORT_22=""
PORT_80=""
PORT_443=""
PORT_4747=""
GATEWAY=""
NET_SKIP=""
KILL_SWITCH=""
LOADED_AGENT_CAP=""
LOADED_GLOBAL_CAP=""
LOADED_MAX_POP=""
LOADED_MAX_DEPTH=""
PROBE_ID_FOUND=""
PROBE_CONTAINER=""

declare -A SOAK=()

PROBE_JS=$(cat <<'JS'
const net = require("net");

function probe(host, port, ms) {
  return new Promise((resolve) => {
    if (!host) {
      resolve("skipped");
      return;
    }
    const socket = net.connect({ host, port });
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    timer = setTimeout(() => finish("timeout"), ms);
    socket.once("connect", () => finish("open"));
    socket.once("error", (err) => {
      const code = err && err.code ? String(err.code) : "error";
      if (code === "ECONNREFUSED" || code === "ECONNRESET") finish("refused");
      else finish("unreachable");
    });
  });
}

(async () => {
  const gateway = process.env.GATEWAY || "";
  const meta = await probe("169.254.169.254", 80, 3000);
  const lines = ["metadata=" + meta];
  if (gateway) {
    const ports = [22, 80, 443, 4747];
    const results = await Promise.all(ports.map((port) => probe(gateway, port, 3000)));
    ports.forEach((port, index) => {
      lines.push("port" + port + "=" + results[index]);
    });
  }
  process.stdout.write(lines.join("\n") + "\n");
})().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write(message + "\n");
  process.exit(1);
});
JS
)

usage() {
  cat <<'EOF'
Usage: scripts/preflight.sh [--allow-skip]

Prints PASS, FAIL, or SKIP for six checks. Exits 0 when every check passes.
A SKIP is a failure unless --allow-skip is set. Secret values are never printed.
EOF
}

record() {
  local status="$1"
  local name="$2"
  local detail="$3"
  printf '%-4s  %-14s  %s\n' "$status" "$name" "$detail"
  case "$status" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    SKIP) SKIP_COUNT=$((SKIP_COUNT + 1)) ;;
    *) printf 'internal: bad status %s\n' "$status" >&2; exit 2 ;;
  esac
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

scrub() {
  local text="$1"
  text="${text//$'\n'/ }"
  text="${text//$'\r'/ }"
  if ((${#text} > 160)); then
    text="${text:0:160}"
  fi
  printf '%s' "$text" | sed -E \
    -e 's/(TOKEN|KEY|SECRET|PASSWORD)=[^ ]+/\1=***/Ig' \
    -e 's/[0-9a-fA-F]{32,}/[redacted]/g'
}

load_soak() {
  local file="$1"
  local line key val
  [[ -f "$file" && -r "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    if [[ "$line" =~ ^[[:space:]]*export[[:space:]]+(.+)$ ]]; then
      line="${BASH_REMATCH[1]}"
    fi
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    if [[ ${#val} -ge 2 && "${val:0:1}" == '"' && "${val: -1}" == '"' ]]; then
      val="${val:1:${#val}-2}"
    elif [[ ${#val} -ge 2 && "${val:0:1}" == "'" && "${val: -1}" == "'" ]]; then
      val="${val:1:${#val}-2}"
    fi
    val=$(trim "$val")
    SOAK["$key"]="$val"
  done < "$file"
}

usd_units() {
  local raw="$1"
  raw="${raw//\$/}"
  raw="${raw//[[:space:]]/}"
  local whole frac
  if [[ "$raw" =~ ^([0-9]+)\.([0-9]{1,6})$ ]]; then
    whole="${BASH_REMATCH[1]}"
    frac="${BASH_REMATCH[2]}"
  elif [[ "$raw" =~ ^([0-9]+)$ ]]; then
    whole="${BASH_REMATCH[1]}"
    frac=""
  else
    return 1
  fi
  while ((${#frac} < 6)); do
    frac="${frac}0"
  done
  printf '%s\n' "$((10#$whole * 1000000 + 10#$frac))"
}

have_parser() {
  command -v python3 >/dev/null 2>&1 || command -v node >/dev/null 2>&1
}

parse_overview() {
  local json="$1"
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$json" | python3 -c '
import json, sys
data = json.load(sys.stdin)
def emit(key, value):
    text = "" if value is None else str(value)
    if "\n" in text or "\r" in text:
        text = ""
    sys.stdout.write(key + "=" + text + "\n")
emit("killSwitch", "on" if data.get("killSwitch") else "off")
emit("agentCap", data.get("agentCap", ""))
emit("globalCap", data.get("globalCap", ""))
emit("maxPopulation", data.get("maxPopulation", ""))
emit("maxDepth", data.get("maxDepth", ""))
probe = ""
container = ""
for agent in data.get("agents") or []:
    if not isinstance(agent, dict):
        continue
    if agent.get("name") == "preflight-probe" and agent.get("status") != "archived":
        probe = str(agent.get("id") or "")
        container = str(agent.get("containerId") or "")
        break
emit("probeId", probe)
emit("probeContainer", container)
' 2>/dev/null
    return
  fi
  printf '%s' "$json" | node --input-type=commonjs -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
function emit(key, value) {
  let text = value === undefined || value === null ? "" : String(value);
  if (text.includes("\n") || text.includes("\r")) text = "";
  process.stdout.write(key + "=" + text + "\n");
}
emit("killSwitch", data.killSwitch ? "on" : "off");
emit("agentCap", data.agentCap ?? "");
emit("globalCap", data.globalCap ?? "");
emit("maxPopulation", data.maxPopulation ?? "");
emit("maxDepth", data.maxDepth ?? "");
let probe = "";
let container = "";
for (const agent of data.agents || []) {
  if (agent && agent.name === "preflight-probe" && agent.status !== "archived") {
    probe = agent.id || "";
    container = agent.containerId || "";
    break;
  }
}
emit("probeId", probe);
emit("probeContainer", container);
' 2>/dev/null
}

assign_overview() {
  local line key val
  KILL_SWITCH=""
  LOADED_AGENT_CAP=""
  LOADED_GLOBAL_CAP=""
  LOADED_MAX_POP=""
  LOADED_MAX_DEPTH=""
  PROBE_ID_FOUND=""
  PROBE_CONTAINER=""
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    key="${line%%=*}"
    val="${line#*=}"
    case "$key" in
      killSwitch) KILL_SWITCH="$val" ;;
      agentCap) LOADED_AGENT_CAP="$val" ;;
      globalCap) LOADED_GLOBAL_CAP="$val" ;;
      maxPopulation) LOADED_MAX_POP="$val" ;;
      maxDepth) LOADED_MAX_DEPTH="$val" ;;
      probeId) PROBE_ID_FOUND="$val" ;;
      probeContainer) PROBE_CONTAINER="$val" ;;
      *) ;;
    esac
  done <<< "$1"
}

parse_id() {
  local json="$1"
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$json" | python3 -c '
import json, sys
data = json.load(sys.stdin)
ident = data.get("id") if isinstance(data, dict) else ""
sys.stdout.write(ident if isinstance(ident, str) else "")
' 2>/dev/null
    return
  fi
  printf '%s' "$json" | node --input-type=commonjs -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(data && typeof data.id === "string" ? data.id : "");
' 2>/dev/null
}

http() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local timeout="${4:-20}"
  local tmp code curl_rc=0
  tmp=$(mktemp)
  local -a args=(
    --silent
    --max-time "$timeout"
    --output "$tmp"
    --write-out "%{http_code}"
    --request "$method"
    --header "Accept: application/json"
  )
  if [[ -n "$PREFLIGHT_TOKEN" ]]; then
    args+=(--header "X-Admin-Token: ${PREFLIGHT_TOKEN}")
  fi
  if [[ -n "$body" ]]; then
    args+=(--header "Content-Type: application/json" --data "$body")
  fi
  code=$(curl "${args[@]}" "${BASE_URL}${path}") || curl_rc=$?
  HTTP_CODE="$code"
  HTTP_BODY=$(cat "$tmp" 2>/dev/null || true)
  rm -f "$tmp"
  if [[ "$curl_rc" -ne 0 || ! "$code" =~ ^2[0-9][0-9]$ ]]; then
    if [[ "$curl_rc" -ne 0 ]]; then
      HTTP_CODE="000"
    fi
    return 1
  fi
}

health() {
  curl --silent --max-time 3 --fail "${BASE_URL}/health" >/dev/null 2>&1
}

docker_ready() {
  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
    return 0
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    DOCKER=(sudo -n docker)
    return 0
  fi
  return 1
}

container_running() {
  local name="$1"
  local state
  state=$("${DOCKER[@]}" inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)
  [[ "$state" == "true" ]]
}

wait_running() {
  local name="$1"
  local seconds="$2"
  local deadline=$((SECONDS + seconds))
  while (( SECONDS < deadline )); do
    if container_running "$name"; then
      return 0
    fi
    sleep 1
  done
  container_running "$name"
}

remove_probe() {
  [[ "$REMOVE_PROBE" == "1" ]] || return 0
  [[ "$PROBE_ID" =~ ^a[0-9a-f]{16}$ ]] || return 0
  REMOVE_PROBE=0
  "${DOCKER[@]}" rm -f "automaton-${PROBE_ID}" >/dev/null 2>&1 || true
}

restore_kill() {
  if [[ "$NEED_KILL_RESTORE" != "1" ]]; then
    remove_probe
    return 0
  fi
  NEED_KILL_RESTORE=0
  local enabled="false"
  if [[ "$KILL_PREV" == "on" ]]; then
    enabled="true"
  fi
  http POST /admin/kill-switch "{\"enabled\":${enabled}}" 90 || true
  if [[ "$enabled" == "false" ]]; then
    remove_probe
  fi
}

cleanup() {
  local status=$?
  "${DOCKER[@]}" rm -f automaton-preflight-net >/dev/null 2>&1 || true
  restore_kill || true
  exit "$status"
}

pick_image() {
  local -a candidates=("$AGENT_IMAGE_NAME" "automaton:2" "node:22-bookworm-slim" "node:22" "node:22-alpine")
  local candidate seen=" "
  for candidate in "${candidates[@]}"; do
    [[ -z "$candidate" ]] && continue
    [[ "$seen" == *" ${candidate} "* ]] && continue
    seen+=" ${candidate} "
    if "${DOCKER[@]}" image inspect "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

run_container_probe() {
  local image out_file err_file probe_rc=0
  if ! image=$(pick_image); then
    NET_SKIP="no local image with node for a throwaway container"
    return 0
  fi
  GATEWAY=$("${DOCKER[@]}" network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$NETWORK" 2>/dev/null || true)
  GATEWAY=$(trim "$GATEWAY")
  if [[ ! "$GATEWAY" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ && ! "$GATEWAY" =~ ^[0-9A-Fa-f:]+$ ]]; then
    GATEWAY=""
  fi
  out_file=$(mktemp)
  err_file=$(mktemp)
  "${DOCKER[@]}" rm -f automaton-preflight-net >/dev/null 2>&1 || true
  if command -v timeout >/dev/null 2>&1; then
    printf '%s\n' "$PROBE_JS" | timeout --kill-after=5 20 "${DOCKER[@]}" run --rm -i \
      --name automaton-preflight-net \
      --network "$NETWORK" \
      --env "GATEWAY=${GATEWAY}" \
      --entrypoint node \
      "$image" \
      --input-type=commonjs - \
      >"$out_file" 2>"$err_file" || probe_rc=$?
  else
    printf '%s\n' "$PROBE_JS" | "${DOCKER[@]}" run --rm -i \
      --name automaton-preflight-net \
      --network "$NETWORK" \
      --env "GATEWAY=${GATEWAY}" \
      --entrypoint node \
      "$image" \
      --input-type=commonjs - \
      >"$out_file" 2>"$err_file" || probe_rc=$?
  fi
  local line
  while IFS= read -r line; do
    case "$line" in
      metadata=*) META_RESULT="${line#metadata=}" ;;
      port22=*) PORT_22="${line#port22=}" ;;
      port80=*) PORT_80="${line#port80=}" ;;
      port443=*) PORT_443="${line#port443=}" ;;
      port4747=*) PORT_4747="${line#port4747=}" ;;
      *) ;;
    esac
  done < "$out_file"
  if [[ -z "$META_RESULT" ]]; then
    local reason
    reason=$(scrub "$(cat "$err_file" 2>/dev/null || true)")
    if [[ "$probe_rc" -eq 124 ]]; then
      NET_SKIP="throwaway container timed out"
    elif [[ -n "$reason" ]]; then
      NET_SKIP="throwaway container failed: ${reason}"
    else
      NET_SKIP="throwaway container failed (exit ${probe_rc})"
    fi
  fi
  rm -f "$out_file" "$err_file"
}

check_network() {
  if ! command -v docker >/dev/null 2>&1; then
    NET_SKIP="docker is not installed"
  elif ! docker_ready; then
    NET_SKIP="docker daemon is not reachable"
  elif [[ ! "$NETWORK" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; then
    NET_SKIP="DOCKER_NETWORK is not a usable network name"
  elif ! "${DOCKER[@]}" network inspect "$NETWORK" >/dev/null 2>&1; then
    NET_SKIP="docker network ${NETWORK} does not exist"
  else
    run_container_probe
  fi

  if [[ -n "$NET_SKIP" ]]; then
    record SKIP 1-metadata "$NET_SKIP"
    record SKIP 2-host-ports "$NET_SKIP"
    return
  fi

  case "$META_RESULT" in
    timeout|unreachable)
      record PASS 1-metadata "169.254.169.254 unreachable from a container on ${NETWORK}"
      ;;
    open|refused)
      record FAIL 1-metadata "169.254.169.254 was reachable from a container on ${NETWORK} (${META_RESULT})"
      ;;
    *)
      record FAIL 1-metadata "metadata probe returned ${META_RESULT:-nothing}"
      ;;
  esac

  if [[ -z "$GATEWAY" ]]; then
    record SKIP 2-host-ports "docker network ${NETWORK} has no gateway"
    return
  fi

  local -a open_ports=()
  local port result
  for port in 22 80 443 4747; do
    case "$port" in
      22) result="$PORT_22" ;;
      80) result="$PORT_80" ;;
      443) result="$PORT_443" ;;
      4747) result="$PORT_4747" ;;
      *) result="" ;;
    esac
    if [[ "$result" == "open" ]]; then
      open_ports+=("$port")
    elif [[ "$result" != "timeout" && "$result" != "unreachable" && "$result" != "refused" ]]; then
      record FAIL 2-host-ports "probe did not report port ${port}"
      return
    fi
  done
  if ((${#open_ports[@]} > 0)); then
    record FAIL 2-host-ports "gateway ${GATEWAY} accepted a connection on port ${open_ports[*]}"
    return
  fi
  record PASS 2-host-ports "ports 22, 80, 443, and 4747 are not reachable on gateway ${GATEWAY}"
}

check_bind() {
  local ss_bin listing rc=0 line field addr port
  if ss_bin=$(command -v ss 2>/dev/null); then
    :
  elif [[ -x /usr/bin/ss ]]; then
    ss_bin=/usr/bin/ss
  else
    record SKIP 3-bind-4747 "ss is not installed"
    return
  fi
  listing=$("$ss_bin" -ltn 2>&1) || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    record SKIP 3-bind-4747 "ss could not list listeners"
    return
  fi
  local -a public=()
  while IFS= read -r line; do
    local -a fields=()
    read -ra fields <<< "$line" || true
    for field in "${fields[@]}"; do
      [[ "$field" == *:4747 ]] || continue
      if [[ "$field" == \[*\]:* ]]; then
        addr="${field#\[}"
        addr="${addr%\]:*}"
      else
        addr="${field%:*}"
      fi
      port="${field##*:}"
      [[ "$port" == "4747" ]] || continue
      case "$addr" in
        127.0.0.1|::1|::ffff:127.0.0.1) ;;
        *) public+=("$addr") ;;
      esac
    done
  done <<< "$listing"
  if ((${#public[@]} > 0)); then
    record FAIL 3-bind-4747 "4747 is listening on ${public[*]}"
    return
  fi
  record PASS 3-bind-4747 "4747 is not listening on a public interface"
}

check_secrets() {
  local file="${ROOT}/.env.soak"
  if [[ ! -e "$file" ]]; then
    record SKIP 4-soak-env ".env.soak not found"
    return
  fi
  if [[ ! -r "$file" ]]; then
    record SKIP 4-soak-env ".env.soak is not readable"
    return
  fi
  local -a empty=()
  local name
  for name in WALLET_MASTER_KEY ADMIN_TOKEN TREASURY_ADDRESS; do
    if [[ -z "${SOAK[$name]:-}" ]]; then
      empty+=("$name")
    fi
  done
  if ((${#empty[@]} > 0)); then
    record FAIL 4-soak-env "empty: ${empty[*]}"
    return
  fi
  record PASS 4-soak-env "WALLET_MASTER_KEY, ADMIN_TOKEN, TREASURY_ADDRESS are set"
}

read_overview() {
  local parsed
  if ! http GET /api/overview "" 10; then
    return 1
  fi
  if ! parsed=$(parse_overview "$HTTP_BODY"); then
    return 2
  fi
  assign_overview "$parsed"
  return 0
}

check_kill() {
  if ! command -v curl >/dev/null 2>&1; then
    record SKIP 5-kill-switch "curl is not installed"
    return
  fi
  if ! health; then
    record SKIP 5-kill-switch "orchestrator is not reachable at ${BASE_URL}"
    return
  fi
  if ! command -v docker >/dev/null 2>&1; then
    record SKIP 5-kill-switch "docker is not installed"
    return
  fi
  if ! docker_ready; then
    record SKIP 5-kill-switch "docker daemon is not reachable"
    return
  fi
  if [[ -z "$PREFLIGHT_TOKEN" ]]; then
    record SKIP 5-kill-switch "ADMIN_TOKEN is empty"
    return
  fi
  if [[ "$PREFLIGHT_TOKEN" == *$'\n'* || "$PREFLIGHT_TOKEN" == *$'\r'* || "$PREFLIGHT_TOKEN" == *" "* ]]; then
    record SKIP 5-kill-switch "ADMIN_TOKEN is not a single token"
    return
  fi
  if ! have_parser; then
    record SKIP 5-kill-switch "python3 or node is required to read status"
    return
  fi

  local overview_rc=0
  read_overview || overview_rc=$?
  if [[ "$overview_rc" -ne 0 ]]; then
    record FAIL 5-kill-switch "status request failed (HTTP ${HTTP_CODE})"
    return
  fi
  if [[ "$KILL_SWITCH" != "on" && "$KILL_SWITCH" != "off" ]]; then
    record FAIL 5-kill-switch "status did not report the kill switch"
    return
  fi

  KILL_PREV="$KILL_SWITCH"
  local id="$PROBE_ID_FOUND"
  if [[ -z "$id" ]]; then
    if [[ "$KILL_PREV" == "on" ]]; then
      # Creating a body while the switch is on would leave a container up.
      NEED_KILL_RESTORE=1
      http POST /admin/kill-switch '{"enabled":false}' 90 || true
    fi
    if ! http POST /admin/agents '{"name":"preflight-probe","genesisPrompt":"Preflight probe. Stay idle."}' 90; then
      if [[ "$HTTP_CODE" == "401" ]]; then
        record FAIL 5-kill-switch "admin endpoint rejected ADMIN_TOKEN"
      else
        record SKIP 5-kill-switch "could not start a test agent (HTTP ${HTTP_CODE})"
      fi
      return
    fi
    id=$(parse_id "$HTTP_BODY" || true)
    read_overview || true
    if [[ -n "$PROBE_ID_FOUND" ]]; then
      id="$PROBE_ID_FOUND"
    fi
  fi
  if [[ ! "$id" =~ ^a[0-9a-f]{16}$ ]]; then
    record SKIP 5-kill-switch "test agent id was not usable"
    return
  fi
  PROBE_ID="$id"
  REMOVE_PROBE=1
  if [[ "$PROBE_CONTAINER" == process:* || "$PROBE_CONTAINER" == fake:* ]]; then
    record SKIP 5-kill-switch "orchestrator runtime is not docker"
    return
  fi

  local name="automaton-${id}"
  if ! container_running "$name"; then
    if [[ "$KILL_PREV" == "on" ]]; then
      NEED_KILL_RESTORE=1
    fi
    http POST /admin/kill-switch '{"enabled":false}' 90 || true
  fi
  if ! wait_running "$name" 30; then
    record SKIP 5-kill-switch "test agent container did not start within 30s"
    return
  fi

  local start="${SECONDS}"
  NEED_KILL_RESTORE=1
  if ! http POST /admin/kill-switch '{"enabled":true}' 90; then
    if [[ "$HTTP_CODE" == "401" ]]; then
      record FAIL 5-kill-switch "admin endpoint rejected ADMIN_TOKEN"
    else
      record FAIL 5-kill-switch "kill switch request failed (HTTP ${HTTP_CODE})"
    fi
    return
  fi
  while (( SECONDS - start < 30 )); do
    if ! container_running "$name"; then
      record PASS 5-kill-switch "kill switch stopped ${name} within 30s"
      return
    fi
    sleep 1
  done
  if container_running "$name"; then
    record FAIL 5-kill-switch "kill switch left ${name} running after 30s"
    return
  fi
  record PASS 5-kill-switch "kill switch stopped ${name} within 30s"
}

compare_usd() {
  local label="$1"
  local loaded="$2"
  local expected="$3"
  local left right
  if [[ -z "$expected" ]]; then
    printf '%s missing from .env.soak' "$label"
    return 1
  fi
  if [[ -z "$loaded" ]]; then
    printf '%s missing from orchestrator status' "$label"
    return 1
  fi
  if ! left=$(usd_units "$loaded"); then
    printf '%s from the orchestrator is not a USD amount' "$label"
    return 1
  fi
  if ! right=$(usd_units "$expected"); then
    printf '%s in .env.soak is not a USD amount' "$label"
    return 1
  fi
  if [[ "$left" != "$right" ]]; then
    printf '%s loaded %s, .env.soak has %s' "$label" "$loaded" "$expected"
    return 1
  fi
}

compare_int() {
  local label="$1"
  local loaded="$2"
  local expected="$3"
  if [[ -z "$expected" ]]; then
    printf '%s missing from .env.soak' "$label"
    return 1
  fi
  if [[ ! "$loaded" =~ ^[0-9]+$ || ! "$expected" =~ ^[0-9]+$ ]]; then
    printf '%s loaded %s, .env.soak has %s' "$label" "${loaded:-nothing}" "$expected"
    return 1
  fi
  if [[ "$((10#$loaded))" -ne "$((10#$expected))" ]]; then
    printf '%s loaded %s, .env.soak has %s' "$label" "$loaded" "$expected"
    return 1
  fi
}

check_caps() {
  if [[ ! -e "${ROOT}/.env.soak" ]]; then
    record SKIP 6-caps ".env.soak not found"
    return
  fi
  if [[ ! -r "${ROOT}/.env.soak" ]]; then
    record SKIP 6-caps ".env.soak is not readable"
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    record SKIP 6-caps "curl is not installed"
    return
  fi
  if ! health; then
    record SKIP 6-caps "orchestrator is not reachable at ${BASE_URL}"
    return
  fi
  if ! have_parser; then
    record SKIP 6-caps "python3 or node is required to read status"
    return
  fi
  local overview_rc=0
  read_overview || overview_rc=$?
  if [[ "$overview_rc" -ne 0 ]]; then
    record FAIL 6-caps "status request failed (HTTP ${HTTP_CODE})"
    return
  fi

  local -a problems=()
  local msg
  if ! msg=$(compare_usd "agent cap" "$LOADED_AGENT_CAP" "${SOAK[AGENT_DAILY_CAP_USD]:-}"); then
    problems+=("$msg")
  fi
  if ! msg=$(compare_usd "global cap" "$LOADED_GLOBAL_CAP" "${SOAK[GLOBAL_DAILY_CAP_USD]:-}"); then
    problems+=("$msg")
  fi
  if ! msg=$(compare_int "population" "$LOADED_MAX_POP" "${SOAK[MAX_POPULATION]:-}"); then
    problems+=("$msg")
  fi
  if ! msg=$(compare_int "depth" "$LOADED_MAX_DEPTH" "${SOAK[MAX_DEPTH]:-}"); then
    problems+=("$msg")
  fi
  if ((${#problems[@]} > 0)); then
    local detail="" item
    for item in "${problems[@]}"; do
      if [[ -n "$detail" ]]; then
        detail+="; "
      fi
      detail+="$item"
    done
    record FAIL 6-caps "$detail"
    return
  fi
  record PASS 6-caps "agent ${LOADED_AGENT_CAP}, global ${LOADED_GLOBAL_CAP}, population ${LOADED_MAX_POP}, depth ${LOADED_MAX_DEPTH}"
}

finish() {
  printf 'preflight: %d passed, %d failed, %d skipped\n' "$PASS_COUNT" "$FAIL_COUNT" "$SKIP_COUNT"
  if (( FAIL_COUNT > 0 )); then
    exit 1
  fi
  if (( SKIP_COUNT > 0 && ALLOW_SKIP == 0 )); then
    exit 1
  fi
  exit 0
}

main() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --allow-skip) ALLOW_SKIP=1 ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        printf 'Unknown argument: %s\n' "$1" >&2
        usage
        exit 2
        ;;
    esac
    shift
  done

  ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  cd "$ROOT"
  if [[ -r "${ROOT}/.env.soak" ]]; then
    load_soak "${ROOT}/.env.soak"
  fi

  if [[ -n "${DOCKER_NETWORK:-}" ]]; then
    NETWORK="$DOCKER_NETWORK"
  else
    NETWORK="${SOAK[DOCKER_NETWORK]:-automaton_default}"
  fi
  if [[ -n "${PORT:-}" ]]; then
    PORT_NUM="$PORT"
  else
    PORT_NUM="${SOAK[PORT]:-4747}"
  fi
  if [[ -n "${AUTOMATON_URL:-}" ]]; then
    BASE_URL="${AUTOMATON_URL%/}"
  else
    BASE_URL="http://127.0.0.1:${PORT_NUM}"
  fi
  PREFLIGHT_TOKEN="${SOAK[ADMIN_TOKEN]:-}"
  if [[ -z "$PREFLIGHT_TOKEN" ]]; then
    PREFLIGHT_TOKEN="$ADMIN_TOKEN_FROM_ENV"
  fi
  if [[ -n "${AGENT_IMAGE:-}" ]]; then
    AGENT_IMAGE_NAME="$AGENT_IMAGE"
  else
    AGENT_IMAGE_NAME="${SOAK[AGENT_IMAGE]:-automaton:2}"
  fi

  trap cleanup EXIT
  check_network
  check_bind
  check_secrets
  check_kill
  check_caps
  finish
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
