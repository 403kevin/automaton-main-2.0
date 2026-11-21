import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// specs/BO-3.1d-host-input-drop.md: new container-to-host connections on bridge interfaces are dropped.

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "host-firewall.sh");

const META = "DOCKER-USER -d 169.254.169.254 -j DROP";
const BR = "INPUT -i br-+ -m conntrack --ctstate NEW -j DROP";
const DOCKER0 = "INPUT -i docker0 -m conntrack --ctstate NEW -j DROP";

const BR_INSERT = "iptables -I INPUT 1 -i br-+ -m conntrack --ctstate NEW -j DROP";
const DOCKER0_INSERT = "iptables -I INPUT 1 -i docker0 -m conntrack --ctstate NEW -j DROP";

function writeExe(file: string, body: string): void {
  fs.writeFileSync(file, body.replace(/\r\n/g, "\n"), { mode: 0o755 });
}

function run(present: string[], args: string[]): { status: number; stdout: string; log: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-"));
  const log = path.join(dir, "log");
  const state = path.join(dir, "state");
  fs.writeFileSync(state, present.length ? `${present.join("\n")}\n` : "");
  writeExe(
    path.join(dir, "iptables"),
    `#!/bin/bash
set -u
printf '%s\\n' "iptables $*" >> "$LOG"
cmd="$1"
shift
if [ "$cmd" = "-C" ] || [ "$cmd" = "-I" ]; then
  chain="$1"
  shift
  if [ "$cmd" = "-I" ] && [[ "\${1:-}" =~ ^[0-9]+$ ]]; then shift; fi
  key="$chain $*"
  if [ "$cmd" = "-C" ]; then
    if grep -Fxq "$key" "$STATE"; then exit 0; fi
    printf '%s\\n' 'iptables: Bad rule (does a matching rule exist in that chain?).' >&2
    exit 1
  fi
  if ! grep -Fxq "$key" "$STATE"; then printf '%s\\n' "$key" >> "$STATE"; fi
  exit 0
fi
exit 0
`,
  );
  writeExe(
    path.join(dir, "netfilter-persistent"),
    `#!/bin/bash
printf '%s\\n' "netfilter-persistent $*" >> "$LOG"
exit 0
`,
  );
  writeExe(
    path.join(dir, "id"),
    `#!/bin/bash
if [ "\${1:-}" = "-u" ]; then printf '0\\n'; exit 0; fi
printf '0\\n'
`,
  );
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      LOG: log,
      STATE: state,
    },
  });
  const text = fs.existsSync(log) ? fs.readFileSync(log, "utf8").replace(/\r\n/g, "\n") : "";
  return { status: result.status ?? 1, stdout: result.stdout ?? "", log: text.split("\n").filter(Boolean) };
}

function interfaces(log: string[]): string[] {
  const named: string[] = [];
  for (const line of log) {
    const parts = line.split(/\s+/);
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i] === "-i" && parts[i + 1]) named.push(parts[i + 1]);
    }
  }
  return named;
}

describe("host firewall input drop", () => {
  it("inserts the bridge rules when they are absent", () => {
    const result = run([META], []);
    expect(result.status).toBe(0);
    expect(result.log.filter((line) => line.startsWith("iptables -I INPUT"))).toEqual([BR_INSERT, DOCKER0_INSERT]);
    expect(result.log.some((line) => line.startsWith("iptables -I DOCKER-USER"))).toBe(false);
    expect(result.log).toContain("netfilter-persistent save");
  });

  it("inserts nothing when all three rules are present", () => {
    const result = run([META, BR, DOCKER0], []);
    expect(result.status).toBe(0);
    expect(result.log.filter((line) => line.includes(" -I "))).toEqual([]);
  });

  it("fails --check when any one of the three rules is missing", () => {
    const missingBridge = run([META, DOCKER0], ["--check"]);
    const missingDocker0 = run([META, BR], ["--check"]);
    const missingMeta = run([BR, DOCKER0], ["--check"]);
    for (const result of [missingBridge, missingDocker0, missingMeta]) {
      expect(result.status).toBe(1);
      expect(result.stdout.trim()).toBe("absent");
      expect(result.log.filter((line) => line.includes(" -I "))).toEqual([]);
    }
  });

  it("names no interface other than br-+ and docker0", () => {
    const result = run([], []);
    const named = interfaces(result.log);
    expect(named.every((name) => name === "br-+" || name === "docker0")).toBe(true);
    expect([...new Set(named)].sort()).toEqual(["br-+", "docker0"]);
  });
});
