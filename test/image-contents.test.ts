import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

// specs/BO-3.1b-image-contents.md: an image must contain every relative import at the path that import resolves to.

const HANDLED_SOAK_FILE = "No config/soak.sepolia.env here; using the process environment.";

interface Copy {
  source: string;
  destImage: string;
  destIsDir: boolean;
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function parseDockerfile(text: string): { workdir: string; copies: Copy[] } {
  let workdir = "/";
  const copies: Copy[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("WORKDIR ")) {
      workdir = line.slice("WORKDIR ".length).trim();
      continue;
    }
    if (!line.startsWith("COPY ")) continue;
    const tokens = line.slice("COPY ".length).trim().split(/\s+/);
    const dest = tokens[tokens.length - 1] ?? "";
    const sources = tokens.slice(0, -1);
    const destIsDir = dest === "." || dest === "./" || dest.endsWith("/");
    const destImage = dest.startsWith("/")
      ? dest.replace(/\/+$/, "") || "/"
      : path.posix.join(workdir, dest.replace(/^\.\//, "").replace(/\/+$/, ""));
    for (const source of sources) {
      const src = source.replace(/^\.\//, "");
      const directory = destIsDir || (fs.existsSync(src) && fs.statSync(src).isDirectory());
      copies.push({ source: src, destImage: directory && dest === "./" ? workdir : destImage, destIsDir: directory });
    }
  }
  return { workdir, copies };
}

function imagePath(repoRel: string, copies: Copy[]): string | null {
  const norm = repoRel.replace(/\\/g, "/");
  let best: { length: number; image: string } | null = null;
  for (const copy of copies) {
    if (copy.destIsDir) {
      if (norm !== copy.source && !norm.startsWith(`${copy.source}/`)) continue;
      const rest = norm.slice(copy.source.length).replace(/^\//, "");
      const image = rest ? path.posix.join(copy.destImage, rest) : copy.destImage;
      if (!best || copy.source.length > best.length) best = { length: copy.source.length, image };
    } else if (norm === copy.source && (!best || copy.source.length > best.length)) {
      best = { length: copy.source.length, image: copy.destImage };
    }
  }
  return best?.image ?? null;
}

function relativeSpecs(text: string): string[] {
  const specs = new Set<string>();
  for (const re of [/from\s+["'](\.[^"']+)["']/g, /import\s*\(\s*["'](\.[^"']+)["']\s*\)/g, /import\s+["'](\.[^"']+)["']/g]) {
    for (const match of text.matchAll(re)) if (match[1]) specs.add(match[1]);
  }
  return [...specs];
}

function resolveRepo(fromRepo: string, spec: string): string {
  let target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRepo), spec));
  if (target.endsWith(".js")) target = `${target.slice(0, -3)}.ts`;
  const candidates = [target, `${target}.ts`, path.posix.join(target, "index.ts")];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? candidates[0] ?? target;
}

function resolveImage(fromImage: string, spec: string): string {
  let target = path.posix.normalize(path.posix.join(path.posix.dirname(fromImage), spec));
  if (target.endsWith(".js")) target = `${target.slice(0, -3)}.ts`;
  if (!path.posix.extname(target)) target = `${target}.ts`;
  return target;
}

function sensesFailures(dockerfile: string): string[] {
  const { copies } = parseDockerfile(dockerfile);
  const failures: string[] = [];
  const seen = new Set<string>();
  const pending = ["senses/src/server.ts"];
  while (pending.length > 0) {
    const repoFile = pending.pop();
    if (!repoFile || seen.has(repoFile)) continue;
    seen.add(repoFile);
    if (!fs.existsSync(repoFile)) {
      failures.push(`${repoFile} is imported and is not in the repo`);
      continue;
    }
    const fromImage = imagePath(repoFile, copies);
    for (const spec of relativeSpecs(read(repoFile))) {
      const target = resolveRepo(repoFile, spec);
      if (target.endsWith(".ts") && fs.existsSync(target)) pending.push(target);
      if (!fromImage) {
        failures.push(`${repoFile} is not in the image, so ${spec} cannot resolve`);
        continue;
      }
      const resolved = resolveImage(fromImage, spec);
      const mapped = imagePath(target, copies);
      if (mapped !== resolved) {
        failures.push(`${repoFile} imports ${spec}, which resolves to ${resolved}, but the image ${mapped ? `has it at ${mapped}` : "does not contain it"}`);
      }
    }
  }
  return failures;
}

function srcFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return srcFiles(full);
    return full.endsWith(".ts") ? [full.replace(/\\/g, "/")] : [];
  });
}

describe("images contain everything they import", () => {
  it("places every senses import where that relative import resolves", () => {
    const failures = sensesFailures(read("senses/Dockerfile"));
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("reports feeds when the senses Dockerfile has no feeds copy", () => {
    const text = read("senses/Dockerfile").replace(/^COPY senses\/feeds .*$/m, "");
    const failures = sensesFailures(text);
    expect(failures.join("\n")).toContain("feeds");
  });

  it("keeps orchestrator imports inside src, copies the constitution, and handles a missing default soak file", () => {
    const failures: string[] = [];
    if (!read("Dockerfile").includes("constitution.md")) failures.push("Dockerfile does not COPY constitution.md");
    for (const file of srcFiles("src")) {
      for (const spec of relativeSpecs(read(file))) {
        const target = resolveRepo(file, spec);
        if (!target.startsWith("src/")) failures.push(`${file} imports ${target}, outside src`);
      }
    }
    if (!read("src/cli.ts").includes(HANDLED_SOAK_FILE)) {
      failures.push("config/soak.sepolia.env is read by the CLI and is not handled when missing");
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("seeds with no file argument when the default file is absent, against a healthy server, by calling seedHttp", async () => {
    const names: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200);
        res.end("ok");
        return;
      }
      if (req.method === "GET" && req.url === "/api/overview") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ agents: [] }));
        return;
      }
      if (req.method === "POST" && (req.url === "/admin/agents" || req.url === "/admin/topup")) {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk as Buffer));
        req.on("end", () => {
          if (req.url === "/admin/agents") names.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).name as string);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: `id-${names.at(-1) ?? "topup"}`, address: `0x${"11".repeat(20)}` }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const previous = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soak-seed-"));
    const savedUrl = process.env.AUTOMATON_URL;
    const savedToken = process.env.ADMIN_TOKEN;
    let thrown: string | undefined;
    try {
      process.chdir(dir);
      process.env.AUTOMATON_URL = `http://127.0.0.1:${address.port}`;
      process.env.ADMIN_TOKEN = "check-admin-token";
      try {
        await main(["seed"]);
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
    } finally {
      process.chdir(previous);
      if (savedUrl === undefined) delete process.env.AUTOMATON_URL;
      else process.env.AUTOMATON_URL = savedUrl;
      if (savedToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = savedToken;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    expect(thrown, "seed must call seedHttp").toBeUndefined();
    expect(names).toEqual(["mite", "keel", "wick"]);
  });

  it("still errors when a given config file is missing", async () => {
    await expect(main(["seed", "no-such-soak.env"])).rejects.toThrow();
  });
});
