import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// specs/BO-3.1c-strip-types.md: files the senses image runs as TypeScript must be erasable.

const ROOT = path.resolve(import.meta.dirname, "..");

function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function runtimeTsFiles(): string[] {
  return [
    ...walkTs(path.join(ROOT, "senses", "src")),
    ...walkTs(path.join(ROOT, "senses", "feeds")),
    path.join(ROOT, "src", "constitution.ts"),
  ];
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

async function stripper(): Promise<(code: string, options: { mode: "strip" }) => string> {
  const mod = await import("node:module");
  const fn = (mod as { stripTypeScriptTypes?: unknown }).stripTypeScriptTypes;
  if (typeof fn !== "function") {
    throw new Error("stripTypeScriptTypes is not available on this Node. The strip-only check cannot be skipped.");
  }
  return fn as (code: string, options: { mode: "strip" }) => string;
}

function relativeSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["'](\.\.?\/[^"']+)["']/g,
    /import\s*\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const spec = match[1];
      if (spec) specs.push(spec);
    }
  }
  return specs;
}

function fromLines(dockerfile: string): string[] {
  return dockerfile
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("FROM "))
    .map((line) => line.slice("FROM ".length).trim().split(/\s+/)[0] ?? "");
}

describe("strip-only TypeScript", () => {
  it("strips every TypeScript file the senses image runs", async () => {
    const strip = await stripper();
    const failures: string[] = [];
    for (const file of runtimeTsFiles()) {
      try {
        strip(read(file), { mode: "strip" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${rel(file)}: ${message}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("rejects a parameter property and an enum", async () => {
    const strip = await stripper();
    expect(() => strip("class A { constructor(private x: number) {} }", { mode: "strip" })).toThrow();
    expect(() => strip("enum E { A }", { mode: "strip" })).toThrow();
  });

  it("keeps relative imports on .ts specifiers", () => {
    const bad: string[] = [];
    for (const file of runtimeTsFiles()) {
      for (const spec of relativeSpecifiers(read(file))) {
        if (!spec.endsWith(".ts")) bad.push(`${rel(file)}: ${spec}`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("pins both image FROM lines to an explicit tag", () => {
    const dockerfiles = ["Dockerfile", "senses/Dockerfile"];
    const bad: string[] = [];
    for (const name of dockerfiles) {
      const images = fromLines(read(path.join(ROOT, name)));
      if (images.length === 0) bad.push(`${name}: no FROM`);
      for (const image of images) {
        const colon = image.lastIndexOf(":");
        const tag = colon === -1 ? "" : image.slice(colon + 1);
        if (!tag || tag === "latest") bad.push(`${name}: ${image}`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });
});
