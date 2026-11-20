import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// specs/BO-2.4b-agent-model-compose.md, "Compose forwarding": every setting the app reads must reach the orchestrator on both
// documented compose paths, no compose file may give a secret a default, and a typo in an env file must fail a test.

function read(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

/** Every environment name the source reads: `env.NAME`, `process.env.NAME` and `env["NAME"]`. */
function namesRead(): Set<string> {
  const names = new Set<string>();
  for (const file of walk("src")) {
    const text = read(file);
    for (const match of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) names.add(match[1] ?? "");
    for (const match of text.matchAll(/\benv\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g)) names.add(match[1] ?? "");
  }
  names.delete("");
  return names;
}

function envFileKeys(file: string): string[] {
  const keys: string[] = [];
  for (const line of read(file).split("\n")) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) keys.push(match[1] ?? "");
  }
  return keys;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The lines of one top-level service, without a YAML library (the compose files here are flat and regular). */
function serviceBlock(text: string, service: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start < 0) return [];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && indentOf(line) <= 2) break;
    block.push(line);
  }
  return block;
}

function children(block: string[], key: string): string[] {
  const at = block.findIndex((line) => new RegExp(`^\\s{4}${key}:`).test(line));
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of block.slice(at + 1)) {
    if (line.trim() && indentOf(line) <= 4) break;
    out.push(line);
  }
  return out;
}

interface EnvFile {
  path: string;
  required: boolean;
}

function envFiles(block: string[]): EnvFile[] {
  const lines = children(block, "env_file");
  const files: EnvFile[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const text = (lines[index] ?? "").trim();
    const withPath = /^-\s+path:\s*(\S+)/.exec(text);
    const plain = /^-\s+([^\s:]+)\s*$/.exec(text);
    if (!withPath && !plain) continue;
    const next = (lines[index + 1] ?? "").trim();
    const required = withPath ? !/^required:\s*false/.test(next) : true;
    files.push({ path: (withPath?.[1] ?? plain?.[1] ?? "").replace(/^\.\//, ""), required });
  }
  return files;
}

function environmentKeys(block: string[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const line of children(block, "environment")) {
    const match = /^\s+([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line);
    if (match) keys.set(match[1] ?? "", (match[2] ?? "").trim());
  }
  return keys;
}

const BASE = read("docker-compose.yml");
const SAFE = read("docker-compose.safe.yml");
const baseOrchestrator = serviceBlock(BASE, "orchestrator");
const safeOrchestrator = serviceBlock(SAFE, "orchestrator");

describe("compose forwarding", () => {
  it("finds the orchestrator service in both files (the parser itself works)", () => {
    expect(baseOrchestrator.length).toBeGreaterThan(5);
    expect(safeOrchestrator.length).toBeGreaterThan(3);
    expect(environmentKeys(baseOrchestrator).has("PORT")).toBe(true);
  });

  it("passes .env to the orchestrator on the plain compose path", () => {
    expect(envFiles(baseOrchestrator)).toContainEqual({ path: ".env", required: false });
  });

  it("makes .env.soak a required env_file on the safe path", () => {
    expect(envFiles(safeOrchestrator)).toContainEqual({ path: ".env.soak", required: true });
  });

  it("lets every setting the app reads reach the orchestrator on both paths", () => {
    const baseFiles = envFiles(baseOrchestrator).map((file) => file.path);
    const safeFiles = envFiles(safeOrchestrator).map((file) => file.path);
    const baseNamed = environmentKeys(baseOrchestrator);
    const safeNamed = environmentKeys(safeOrchestrator);
    const unreachable = [...namesRead()].filter((name) => {
      const onPlain = baseFiles.includes(".env") || baseNamed.has(name);
      const onSafe = safeFiles.includes(".env.soak") || safeNamed.has(name) || baseNamed.has(name);
      return !(onPlain && onSafe);
    });
    expect(unreachable).toEqual([]);
  });

  it("gives no secret a default value in any compose file", () => {
    const offenders: string[] = [];
    for (const file of ["docker-compose.yml", "docker-compose.safe.yml", "docker-compose.soak.yml"]) {
      for (const line of read(file).split("\n")) {
        const match = /^\s+([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET)):\s*(.*)$/.exec(line);
        if (!match) continue;
        const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
        const defaulted = /^\$\{[A-Z0-9_]+:-(.+)\}$/.test(value);
        const literal = value !== "" && !value.startsWith("${");
        if (defaulted || literal) offenders.push(`${file}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the safe file's required-secret guards", () => {
    const named = environmentKeys(safeOrchestrator);
    for (const name of ["WALLET_MASTER_KEY", "ADMIN_TOKEN", "TREASURY_ADDRESS"]) {
      expect(named.get(name)).toContain(":?");
    }
  });
});

/** Names that an env file may carry because a script or the CLI reads them, not the app: each with its reason. */
const READ_BY_SCRIPTS: Record<string, string> = {
  SOAK_SEED_USD: "read by the soak seeding in src/cli.ts and src/seed.ts",
};

describe("env files carry only names the app reads", () => {
  const known = namesRead();
  for (const file of ["config/soak.env.template", ".env.example", "config/soak.sepolia.env"]) {
    it(`${file} has no typo'd or unknown setting`, () => {
      const unknown = envFileKeys(file).filter((key) => !known.has(key) && !(key in READ_BY_SCRIPTS));
      expect(unknown).toEqual([]);
    });
  }

  it("catches a typo (the check itself fails on an unknown name)", () => {
    expect(known.has("DEFAULT_MODLE")).toBe(false);
    expect(known.has("DEFAULT_MODEL")).toBe(true);
    expect(known.has("ALLOWED_MODELS")).toBe(true);
  });
});
